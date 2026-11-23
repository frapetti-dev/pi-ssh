import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { utils } from "ssh2";
import { ConnectionPool, type Prompter, SUDO_PROMPT } from "../src/core/connections";
import type { HostSpec } from "../src/core/hosts";
import { hostField, keyInfo } from "../src/core/known-hosts";
import { planTransfer, runTransfer } from "../src/core/transfer";
import { startTestServer, type TestServer } from "./helpers/server";

let tmp: string;
let serverRoot: string;
let knownHosts: string;
let keyFile: string;
let server: TestServer;
let spec: HostSpec;
const pools: ConnectionPool[] = [];

function makePool(file = knownHosts): ConnectionPool {
	const pool = new ConnectionPool({
		knownHostsPath: file,
		agentPath: undefined,
		resolveHost: input => {
			throw new Error(`unexpected resolve ${input}`);
		},
	});
	pools.push(pool);
	return pool;
}

function prompter(over: Partial<Prompter> = {}): Prompter & { hostKeyCalls: number } {
	const p = {
		hostKeyCalls: 0,
		async confirmHostKey() {
			p.hostKeyCalls++;
			return true;
		},
		async askSecret() {
			return undefined;
		},
		...over,
	};
	return p;
}

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ssh-it-"));
	serverRoot = path.join(tmp, "server");
	await fs.mkdir(serverRoot);
	knownHosts = path.join(tmp, "known_hosts");
	const clientKey = utils.generateKeyPairSync("ed25519");
	keyFile = path.join(tmp, "id_ed25519");
	await fs.writeFile(keyFile, clientKey.private, { mode: 0o600 });
	server = await startTestServer({ root: serverRoot, clientPublicKey: clientKey.public, password: "pw" });
	spec = { id: "test", hostName: "127.0.0.1", user: "u", port: server.port, identityFiles: [keyFile] };
});

afterAll(async () => {
	for (const p of pools) p.closeAll();
	await server.close();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("host key trust", () => {
	test("first connect prompts and persists; later connects do not prompt", async () => {
		const first = prompter();
		const pool = makePool();
		const conn = await pool.get(spec, first);
		expect(first.hostKeyCalls).toBe(1);
		const text = await fs.readFile(knownHosts, "utf8");
		expect(text).toContain(`${hostField("127.0.0.1", server.port)} ssh-ed25519 ${server.hostPublicBlob.toString("base64")}`);
		conn.close();

		const second = prompter();
		const again = await makePool().get(spec, second);
		expect(second.hostKeyCalls).toBe(0);
		again.close();
	});

	test("changed key is refused without prompting", async () => {
		const file = path.join(tmp, "known_hosts_tampered");
		const other = utils.parseKey(utils.generateKeyPairSync("ed25519").public);
		if (other instanceof Error) throw other;
		const blob = (Array.isArray(other) ? other[0] : other).getPublicSSH();
		await fs.writeFile(file, `${hostField("127.0.0.1", server.port)} ssh-ed25519 ${blob.toString("base64")}\n`);
		const p = prompter();
		const err = await makePool(file).get(spec, p).then(
			() => undefined,
			(e: Error) => e,
		);
		expect(err?.message).toContain("Host key for");
		expect(err?.message).toContain("changed");
		expect(err?.message).toContain(keyInfo(server.hostPublicBlob).fingerprint);
		expect(p.hostKeyCalls).toBe(0);
	});

	test("declining the prompt refuses and saves nothing", async () => {
		const file = path.join(tmp, "known_hosts_declined");
		const err = await makePool(file)
			.get(spec, prompter({ confirmHostKey: async () => false }))
			.then(
				() => undefined,
				(e: Error) => e,
			);
		expect(err?.message).toBe("Host key not trusted by user.");
		expect(await fs.stat(file).catch(() => undefined)).toBeUndefined();
	});
});

describe("authentication", () => {
	const passwordSpec = (): HostSpec => ({ ...spec, id: "pw", identityFiles: [] });

	test("password via masked prompt", async () => {
		const asked: string[] = [];
		const conn = await makePool().get(
			passwordSpec(),
			prompter({
				askSecret: async title => {
					asked.push(title);
					return "pw";
				},
			}),
		);
		expect(asked).toEqual([`Password for u@127.0.0.1`]);
		conn.close();
	});

	test("cancelled prompt fails authentication", async () => {
		const err = await makePool()
			.get(passwordSpec(), prompter())
			.then(
				() => undefined,
				(e: Error) => e,
			);
		expect(err?.message).toContain("Authentication failed for pw");
	});

	test("wrong password is retried then fails", async () => {
		let n = 0;
		const err = await makePool()
			.get(
				passwordSpec(),
				prompter({
					askSecret: async () => {
						n++;
						return "nope";
					},
				}),
			)
			.then(
				() => undefined,
				(e: Error) => e,
			);
		expect(err?.message).toContain("Authentication failed");
		expect(n).toBe(3);
	});
});

describe("connection", () => {
	test("concurrent get returns one Connection", async () => {
		const pool = makePool();
		const p = prompter();
		const [a, b] = await Promise.all([pool.get(spec, p), pool.get(spec, p)]);
		expect(a).toBe(b);
		expect(p.hostKeyCalls).toBe(0);
		expect(pool.list()).toHaveLength(1);
		let changes = 0;
		pool.onChange(() => changes++);
		pool.close("test");
		await new Promise(r => a.client.once("close", r));
		expect(pool.list()).toHaveLength(0);
		expect(changes).toBe(1);
	});

	test("exec results, stderr, and timeout", async () => {
		const conn = await makePool().get(spec, prompter());
		const ok = await conn.exec("echo hi", { timeoutMs: 5000 });
		expect(ok).toMatchObject({ stdout: "hi\n", stderr: "", code: 0, timedOut: false });
		const fail = await conn.exec("fail", { timeoutMs: 5000 });
		expect(fail).toMatchObject({ stderr: "boom", code: 3, timedOut: false });
		const slow = await conn.exec("sleep", { timeoutMs: 500 });
		expect(slow).toMatchObject({ code: null, timedOut: true });
		const controller = new AbortController();
		// Real timer on purpose: the abort must land while the server-side command is genuinely running.
		setTimeout(() => controller.abort(), 100);
		const aborted = await conn.exec("sleep", { timeoutMs: 5000, signal: controller.signal });
		expect(aborted).toMatchObject({ code: null, signal: "ABORTED", timedOut: false });
		conn.close();
	});
});

describe("sudo", () => {
	const cmd = `sudo -S -p '${SUDO_PROMPT}' -- sh -c id`;

	test("right password runs the command", async () => {
		const conn = await makePool().get(spec, prompter());
		const r = await conn.exec(cmd, { timeoutMs: 5000, sudoPassword: async () => "pw" });
		expect(r).toMatchObject({ stdout: "root\n", stderr: "", code: 0 });
		conn.close();
	});

	test("wrong password is denied after one prompt", async () => {
		const conn = await makePool().get(spec, prompter());
		let calls = 0;
		const r = await conn.exec(cmd, {
			timeoutMs: 5000,
			sudoPassword: async () => {
				calls++;
				return "bad";
			},
		});
		expect(r).toMatchObject({ code: null, signal: "SUDO_DENIED", stderr: "Sorry, try again.\n" });
		expect(calls).toBe(1);
		conn.close();
	});

	test("cancelled prompt", async () => {
		const conn = await makePool().get(spec, prompter());
		const r = await conn.exec(cmd, { timeoutMs: 5000, sudoPassword: async () => undefined });
		expect(r).toMatchObject({ signal: "SUDO_CANCELLED" });
		conn.close();
	});

	test("no prompt means the password is never requested", async () => {
		const conn = await makePool().get(spec, prompter());
		let calls = 0;
		const r = await conn.exec("echo hi", {
			timeoutMs: 5000,
			sudoPassword: async () => {
				calls++;
				return "pw";
			},
		});
		expect(r.stdout).toBe("hi\n");
		expect(calls).toBe(0);
		conn.close();
	});
});

describe("transfer", () => {
	test("recursive upload and download round trip", async () => {
		const conn = await makePool().get(spec, prompter());
		const src = path.join(tmp, "src");
		await fs.mkdir(path.join(src, "sub", "deep"), { recursive: true });
		await fs.writeFile(path.join(src, "a.txt"), "alpha");
		await fs.writeFile(path.join(src, "sub", "b.bin"), Buffer.alloc(100_000, 7));
		await fs.writeFile(path.join(src, "sub", "deep", "empty.txt"), "");
		let symlinked = true;
		await fs.symlink(path.join(src, "a.txt"), path.join(src, "link.txt")).catch(() => {
			symlinked = false;
		});

		await fs.mkdir(path.join(serverRoot, "dest"));
		const up = await planTransfer(conn, "upload", src, "/dest", tmp);
		expect(up.remoteRoot).toBe("/dest/src");
		expect(up.files.map(f => f.remote).sort()).toEqual(["/dest/src/a.txt", "/dest/src/sub/b.bin", "/dest/src/sub/deep/empty.txt"]);
		expect(up.dirs).toEqual(["/dest/src", "/dest/src/sub", "/dest/src/sub/deep"]);
		expect(up.totalBytes).toBe(100_005);
		expect(up.files.some(f => f.exists)).toBe(false);
		if (symlinked) expect(up.skipped).toEqual([path.join(src, "link.txt")]);

		const progress: number[] = [];
		const result = await runTransfer(conn, up, p => progress.push(p.doneBytes));
		expect(result).toMatchObject({ filesDone: 3, bytes: 100_005 });
		expect(progress.at(-1)).toBe(100_005);
		expect(await fs.readFile(path.join(serverRoot, "dest", "src", "a.txt"), "utf8")).toBe("alpha");

		const again = await planTransfer(conn, "upload", src, "/dest", tmp);
		expect(again.files.every(f => f.exists)).toBe(true);

		const down = await planTransfer(conn, "download", "back", "/dest/src", tmp);
		expect(down.localRoot).toBe(path.join(tmp, "back"));
		await runTransfer(conn, down, () => {});
		expect(Buffer.compare(await fs.readFile(path.join(tmp, "back", "sub", "b.bin")), Buffer.alloc(100_000, 7))).toBe(0);
		expect(await fs.readFile(path.join(tmp, "back", "a.txt"), "utf8")).toBe("alpha");
		expect(await fs.readFile(path.join(tmp, "back", "sub", "deep", "empty.txt"), "utf8")).toBe("");
		conn.close();
	});

	test("missing source and abort", async () => {
		const conn = await makePool().get(spec, prompter());
		await expect(planTransfer(conn, "download", "x", "/nope", tmp)).rejects.toThrow("Source not found: /nope");
		const plan = await planTransfer(conn, "upload", path.join(tmp, "src", "a.txt"), "/single.txt", tmp);
		const controller = new AbortController();
		controller.abort();
		await expect(runTransfer(conn, plan, () => {}, controller.signal)).rejects.toThrow("Transfer aborted");
		conn.close();
	});
});
