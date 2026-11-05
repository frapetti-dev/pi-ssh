import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SFTPWrapper } from "ssh2";
import type { Connection } from "./connections";

export interface TransferPlan {
	direction: "upload" | "download";
	/** Resolved absolute local root of the copy (source for uploads, target for downloads). */
	localRoot: string;
	/** Resolved absolute remote root of the copy. */
	remoteRoot: string;
	files: { local: string; remote: string; size: number; exists: boolean }[];
	/** Directories to create on the destination side, parents first. */
	dirs: string[];
	/** Symlinks and special files that are not copied. */
	skipped: string[];
	totalBytes: number;
}

interface Entry {
	kind: "file" | "dir" | "other";
	size: number;
}

/** One side (local or remote) of a transfer. */
interface Side {
	join(...parts: string[]): string;
	basename(p: string): string;
	/** Follows symlinks; undefined when missing. */
	kind(p: string): Promise<Entry | undefined>;
	/** Does not follow symlinks (symlinks are kind "other"). */
	list(p: string): Promise<(Entry & { name: string })[]>;
}

type Callback<T> = (err: Error | null | undefined, value: T) => void;

function call<T>(fn: (cb: Callback<T>) => void): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	fn((err, value) => (err ? reject(err) : resolve(value)));
	return promise;
}

function isMissing(e: unknown): boolean {
	if (!e || typeof e !== "object" || !("code" in e)) return false;
	return e.code === "ENOENT" || e.code === 2;
}

const localSide: Side = {
	join: (...p) => path.join(...p),
	basename: p => path.basename(p),
	async kind(p) {
		try {
			const s = await fs.stat(p);
			return { kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", size: s.size };
		} catch (e) {
			if (isMissing(e)) return undefined;
			throw e;
		}
	},
	async list(p) {
		const names = await fs.readdir(p);
		const out: (Entry & { name: string })[] = [];
		for (const name of names.sort()) {
			const s = await fs.lstat(path.join(p, name));
			out.push({ name, kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", size: s.size });
		}
		return out;
	},
};

function remoteSide(sftp: SFTPWrapper): Side {
	return {
		join: (...p) => path.posix.join(...p),
		basename: p => path.posix.basename(p),
		async kind(p) {
			try {
				const s = await call<{ isDirectory(): boolean; isFile(): boolean; size: number }>(cb => sftp.stat(p, cb));
				return { kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", size: s.size };
			} catch (e) {
				if (isMissing(e)) return undefined;
				throw e;
			}
		},
		async list(p) {
			const list = await call(cb => sftp.readdir(p, cb));
			return list
				.filter(e => e.filename !== "." && e.filename !== "..")
				.sort((a, b) => a.filename.localeCompare(b.filename))
				.map(e => ({
					name: e.filename,
					kind: e.attrs.isDirectory() ? "dir" : e.attrs.isFile() ? "file" : "other",
					size: e.attrs.size,
				}));
		},
	};
}

async function resolveRemote(sftp: SFTPWrapper, p: string): Promise<string> {
	if (p.startsWith("/")) return path.posix.normalize(p);
	const home = await call<string>(cb => sftp.realpath(".", cb));
	if (p === "~") return home;
	return path.posix.join(home, p.startsWith("~/") ? p.slice(2) : p);
}

export async function planTransfer(
	conn: Connection,
	direction: "upload" | "download",
	localPath: string,
	remotePath: string,
	cwd: string,
): Promise<TransferPlan> {
	const sftp = await conn.sftp();
	const local = path.resolve(cwd, localPath);
	const remote = await resolveRemote(sftp, remotePath);
	const remoteS = remoteSide(sftp);
	const [src, dst] = direction === "upload" ? [localSide, remoteS] : [remoteS, localSide];
	const srcPath = direction === "upload" ? local : remote;
	const dstPath = direction === "upload" ? remote : local;

	const srcKind = await src.kind(srcPath);
	if (!srcKind) throw new Error(`Source not found: ${srcPath}`);
	if (srcKind.kind === "other") throw new Error(`Source is not a regular file or directory: ${srcPath}`);

	// scp -r semantics: an existing destination directory receives the source under its own name.
	const dstKind = await dst.kind(dstPath);
	const target = dstKind?.kind === "dir" ? dst.join(dstPath, src.basename(srcPath)) : dstPath;
	const targetKind = target === dstPath ? dstKind : await dst.kind(target);

	const plan: TransferPlan = {
		direction,
		localRoot: direction === "upload" ? local : target,
		remoteRoot: direction === "upload" ? target : remote,
		files: [],
		dirs: [],
		skipped: [],
		totalBytes: 0,
	};
	const addFile = (s: string, d: string, size: number) => {
		plan.files.push({
			local: direction === "upload" ? s : d,
			remote: direction === "upload" ? d : s,
			size,
			exists: false,
		});
		plan.totalBytes += size;
	};

	if (srcKind.kind === "file") {
		if (targetKind?.kind === "dir") throw new Error(`Cannot overwrite directory with a file: ${target}`);
		addFile(srcPath, target, srcKind.size);
	} else {
		if (targetKind?.kind === "file") throw new Error(`Cannot copy a directory over a file: ${target}`);
		const walk = async (s: string, d: string): Promise<void> => {
			plan.dirs.push(d);
			for (const e of await src.list(s)) {
				const sp = src.join(s, e.name);
				const dp = dst.join(d, e.name);
				if (e.kind === "dir") await walk(sp, dp);
				else if (e.kind === "file") addFile(sp, dp, e.size);
				else plan.skipped.push(sp);
			}
		};
		await walk(srcPath, target);
	}

	if (targetKind) {
		for (const f of plan.files) {
			const existing = await dst.kind(direction === "upload" ? f.remote : f.local);
			if (existing?.kind === "dir") throw new Error(`Cannot overwrite directory with a file: ${direction === "upload" ? f.remote : f.local}`);
			f.exists = existing !== undefined;
		}
	}
	return plan;
}

export interface TransferProgress {
	doneBytes: number;
	filesDone: number;
}

export async function runTransfer(
	conn: Connection,
	plan: TransferPlan,
	onProgress: (p: TransferProgress) => void,
	signal?: AbortSignal,
): Promise<{ filesDone: number; bytes: number; skipped: string[] }> {
	const sftp = await conn.sftp();
	const upload = plan.direction === "upload";
	const aborted = () => new Error("Transfer aborted");

	for (const dir of plan.dirs) {
		if (signal?.aborted) throw aborted();
		if (upload) {
			try {
				await call<void>(cb => sftp.mkdir(dir, cb));
			} catch (e) {
				const existing = await remoteSide(sftp).kind(dir);
				if (existing?.kind !== "dir") throw e;
			}
		} else {
			await fs.mkdir(dir, { recursive: true });
		}
	}

	let bytes = 0;
	let filesDone = 0;
	for (const f of plan.files) {
		if (signal?.aborted) throw aborted();
		const base = bytes;
		const step = (transferred: number) => onProgress({ doneBytes: base + transferred, filesDone });
		if (upload) {
			await call<void>(cb => sftp.fastPut(f.local, f.remote, { step }, cb));
		} else {
			await fs.mkdir(path.dirname(f.local), { recursive: true });
			await call<void>(cb => sftp.fastGet(f.remote, f.local, { step }, cb));
		}
		bytes += f.size;
		filesDone++;
		onProgress({ doneBytes: bytes, filesDone });
	}
	return { filesDone, bytes, skipped: plan.skipped };
}
