import * as fs from "node:fs";
import * as path from "node:path";
import { type Connection as ServerClient, Server, type SFTPWrapper, utils } from "ssh2";
import { SUDO_PROMPT } from "../../src/core/connections";

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface TestServer {
	port: number;
	hostPublicBlob: Buffer;
	close(): Promise<void>;
}

export interface TestServerOptions {
	/** Virtual SFTP root "/" maps to this directory. */
	root: string;
	/** OpenSSH-format public key authorised for publickey auth. */
	clientPublicKey?: string;
	password?: string;
}

function attrsOf(s: fs.Stats) {
	return { mode: s.mode, uid: 0, gid: 0, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
}

function attachSftp(sftp: SFTPWrapper, root: string): void {
	const real = (p: string) => path.join(root, p);
	type Handle = { type: "file"; fd: number } | { type: "dir"; entries: string[]; dir: string; sent: boolean };
	const handles = new Map<number, Handle>();
	let nextHandle = 1;
	const newHandle = (h: Handle) => {
		const id = nextHandle++;
		handles.set(id, h);
		return Buffer.from(String(id));
	};
	const lookup = (h: Buffer) => handles.get(Number(h.toString()));
	const statReply = (follow: boolean) => (reqid: number, p: string) => {
		try {
			sftp.attrs(reqid, attrsOf(follow ? fs.statSync(real(p)) : fs.lstatSync(real(p))));
		} catch {
			sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
		}
	};

	sftp.on("REALPATH", (reqid: number, p: string) => {
		const resolved = path.posix.resolve("/", p);
		sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
	});
	sftp.on("STAT", statReply(true));
	sftp.on("LSTAT", statReply(false));
	sftp.on("FSTAT", (reqid: number, h: Buffer) => {
		const handle = lookup(h);
		if (handle?.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
		sftp.attrs(reqid, attrsOf(fs.fstatSync(handle.fd)));
	});
	sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
		try {
			const fd = fs.openSync(real(filename), flagsToString(flags) ?? "r");
			sftp.handle(reqid, newHandle({ type: "file", fd }));
		} catch {
			sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
		}
	});
	sftp.on("READ", (reqid: number, h: Buffer, offset: number, length: number) => {
		const handle = lookup(h);
		if (handle?.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
		const buf = Buffer.alloc(length);
		const n = fs.readSync(handle.fd, buf, 0, length, offset);
		if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
		sftp.data(reqid, buf.subarray(0, n));
	});
	sftp.on("WRITE", (reqid: number, h: Buffer, offset: number, data: Buffer) => {
		const handle = lookup(h);
		if (handle?.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
		fs.writeSync(handle.fd, data, 0, data.length, offset);
		sftp.status(reqid, STATUS_CODE.OK);
	});
	sftp.on("CLOSE", (reqid: number, h: Buffer) => {
		const handle = lookup(h);
		if (handle?.type === "file") fs.closeSync(handle.fd);
		handles.delete(Number(h.toString()));
		sftp.status(reqid, STATUS_CODE.OK);
	});
	sftp.on("OPENDIR", (reqid: number, p: string) => {
		try {
			sftp.handle(reqid, newHandle({ type: "dir", entries: fs.readdirSync(real(p)), dir: real(p), sent: false }));
		} catch {
			sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
		}
	});
	sftp.on("READDIR", (reqid: number, h: Buffer) => {
		const handle = lookup(h);
		if (handle?.type !== "dir" || handle.sent || handle.entries.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
		handle.sent = true;
		sftp.name(
			reqid,
			handle.entries.map(name => ({ filename: name, longname: name, attrs: attrsOf(fs.lstatSync(path.join(handle.dir, name))) })),
		);
	});
	sftp.on("MKDIR", (reqid: number, p: string) => {
		try {
			fs.mkdirSync(real(p));
			sftp.status(reqid, STATUS_CODE.OK);
		} catch {
			sftp.status(reqid, STATUS_CODE.FAILURE);
		}
	});
	sftp.on("SETSTAT", reqid => sftp.status(reqid, STATUS_CODE.OK));
	sftp.on("FSETSTAT", reqid => sftp.status(reqid, STATUS_CODE.OK));
}

function handleClient(client: ServerClient, opts: TestServerOptions): void {
	const clientKey = opts.clientPublicKey ? utils.parseKey(opts.clientPublicKey) : undefined;
	client.on("authentication", ctx => {
		if (ctx.method === "password" && opts.password !== undefined && ctx.password === opts.password) return ctx.accept();
		if (ctx.method === "publickey" && clientKey && !(clientKey instanceof Error)) {
			const k = Array.isArray(clientKey) ? clientKey[0] : clientKey;
			if (ctx.key.algo === k.type && Buffer.compare(ctx.key.data, k.getPublicSSH()) === 0) {
				if (!ctx.signature) return ctx.accept();
				if (ctx.blob && k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
			}
		}
		ctx.reject(["publickey", "password"]);
	});
	client.on("error", () => {});
	client.on("ready", () => {
		client.on("session", accept => {
			const session = accept();
			session.on("exec", (acceptExec, _reject, info) => {
				const stream = acceptExec();
				if (info.command === "echo hi") {
					stream.write("hi\n");
					stream.exit(0);
					stream.end();
				} else if (info.command === "fail") {
					stream.stderr.write("boom");
					stream.exit(3);
					stream.end();
				} else if (info.command.includes(SUDO_PROMPT)) {
					const prompt = info.command.startsWith("sudo-rs ") ? `[sudo: ${SUDO_PROMPT}] Password: ` : SUDO_PROMPT;
					stream.stderr.write(prompt);
					let buf = "";
					stream.on("data", (d: Buffer) => {
						buf += d.toString();
						if (!buf.includes("\n")) return;
						const line = buf;
						buf = "";
						if (line === "pw\n") {
							stream.write("root\n");
							stream.exit(0);
							stream.end();
						} else stream.stderr.write(`Sorry, try again.\n${prompt}`);
					});
				}
				// any other command (e.g. "sleep") never exits
			});
			session.on("sftp", acceptSftp => attachSftp(acceptSftp(), opts.root));
		});
	});
}

export async function startTestServer(opts: TestServerOptions): Promise<TestServer> {
	const hostKey = utils.generateKeyPairSync("ed25519");
	const parsedPublic = utils.parseKey(hostKey.public);
	if (parsedPublic instanceof Error) throw parsedPublic;
	const pub = Array.isArray(parsedPublic) ? parsedPublic[0] : parsedPublic;
	const server = new Server({ hostKeys: [hostKey.private] }, client => handleClient(client, opts));
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server not listening");
	return {
		port: address.port,
		hostPublicBlob: pub.getPublicSSH(),
		close: async () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}
