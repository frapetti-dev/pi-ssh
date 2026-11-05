import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type HostKeyStatus = "match" | "unknown" | "mismatch" | "revoked";

export function keyInfo(blob: Buffer): { type: string; fingerprint: string } {
	const len = blob.readUInt32BE(0);
	const type = blob.subarray(4, 4 + len).toString("ascii");
	const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
	return { type, fingerprint };
}

export function hostField(hostName: string, port: number): string {
	const h = hostName.toLowerCase();
	return port === 22 ? h : `[${h}]:${port}`;
}

function globToRegExp(p: string): RegExp {
	const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${esc}$`, "i");
}

function patternsMatch(patterns: string, field: string): boolean {
	const parts = patterns.split(",");
	if (parts[0]?.startsWith("|1|")) {
		const [, , salt, hash] = parts[0].split("|");
		if (!salt || !hash) return false;
		const h = createHmac("sha1", Buffer.from(salt, "base64")).update(field).digest();
		return h.equals(Buffer.from(hash, "base64"));
	}
	let matched = false;
	for (const raw of parts) {
		const neg = raw.startsWith("!");
		const re = globToRegExp(neg ? raw.slice(1) : raw);
		if (re.test(field)) {
			if (neg) return false;
			matched = true;
		}
	}
	return matched;
}

function parseLine(raw: string): { marker?: string; patterns: string; type: string; b64: string } | undefined {
	const line = raw.trim();
	if (!line || line.startsWith("#")) return undefined;
	const f = line.split(/\s+/);
	let marker: string | undefined;
	if (f[0]?.startsWith("@")) marker = f.shift();
	const [patterns, type, b64] = f;
	if (!patterns || !type || !b64) return undefined;
	return { marker, patterns, type, b64 };
}

export function checkHostKey(
	text: string,
	hostName: string,
	port: number,
	blob: Buffer,
): { status: HostKeyStatus; knownTypes: string[] } {
	const field = hostField(hostName, port);
	const { type } = keyInfo(blob);
	const knownTypes: string[] = [];
	let mismatch = false;
	let match = false;
	let revoked = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const parsed = parseLine(rawLine);
		if (!parsed) continue;
		const { marker, patterns, type: ktype, b64 } = parsed;
		if (marker === "@cert-authority") continue;
		if (!patternsMatch(patterns, field)) continue;
		const lineBlob = Buffer.from(b64, "base64");
		const equal = lineBlob.equals(blob);
		if (marker === "@revoked") {
			if (equal) revoked = true;
			continue;
		}
		if (ktype === type) {
			if (equal) match = true;
			else mismatch = true;
		} else if (!knownTypes.includes(ktype)) knownTypes.push(ktype);
	}
	if (revoked) return { status: "revoked", knownTypes };
	if (match) return { status: "match", knownTypes };
	if (mismatch) return { status: "mismatch", knownTypes };
	return { status: "unknown", knownTypes };
}

export function knownHostsLine(hostName: string, port: number, blob: Buffer): string {
	return `${hostField(hostName, port)} ${keyInfo(blob).type} ${blob.toString("base64")}\n`;
}

export async function appendKnownHost(file: string, hostName: string, port: number, blob: Buffer): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	let prefix = "";
	try {
		const existing = await fs.readFile(file, "utf8");
		if (existing && !existing.endsWith("\n")) prefix = "\n";
	} catch {
		// created below with 0o600
	}
	await fs.appendFile(file, prefix + knownHostsLine(hostName, port, blob), { mode: 0o600 });
}

export interface KnownHostEntry {
	type: string;
	fingerprint: string;
	hashed: boolean;
	revoked: boolean;
	/** True when `removeKnownHosts` would delete or trim this entry. */
	removable: boolean;
}

interface HostLine {
	marker?: string;
	patterns: string;
	type: string;
	b64: string;
	hashed: boolean;
	revoked: boolean;
	removable: boolean;
}

/** Classifies a known_hosts line against a Host; undefined when it is unrelated. */
function matchLine(raw: string, field: string): HostLine | undefined {
	const parsed = parseLine(raw);
	if (!parsed || parsed.marker === "@cert-authority") return undefined;
	if (!patternsMatch(parsed.patterns, field)) return undefined;
	const hashed = parsed.patterns.startsWith("|1|");
	const revoked = parsed.marker === "@revoked";
	const exact = !hashed && parsed.patterns.split(",").some(p => p.toLowerCase() === field);
	return { ...parsed, hashed, revoked, removable: !revoked && (hashed || exact) };
}

export function listKnownHosts(text: string, hostName: string, port: number): KnownHostEntry[] {
	const field = hostField(hostName, port);
	const out: KnownHostEntry[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const m = matchLine(raw, field);
		if (!m) continue;
		let info: { type: string; fingerprint: string };
		try {
			info = keyInfo(Buffer.from(m.b64, "base64"));
		} catch {
			info = { type: m.type, fingerprint: "invalid key" };
		}
		out.push({ type: info.type, fingerprint: info.fingerprint, hashed: m.hashed, revoked: m.revoked, removable: m.removable });
	}
	return out;
}

export function removeKnownHosts(text: string, hostName: string, port: number): { text: string; removed: number } {
	const field = hostField(hostName, port);
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const kept: string[] = [];
	let removed = 0;
	for (const raw of text.split(/\r?\n/)) {
		const m = matchLine(raw, field);
		if (!m?.removable) {
			kept.push(raw);
			continue;
		}
		removed++;
		if (m.hashed) continue;
		const rest = m.patterns.split(",").filter(p => p.toLowerCase() !== field);
		if (rest.length === 0) continue;
		const fields = raw.trim().split(/\s+/);
		const marker = fields[0]?.startsWith("@") ? fields.shift() : undefined;
		fields.shift();
		kept.push([marker, rest.join(","), ...fields].filter(Boolean).join(" "));
	}
	return { text: kept.join(eol), removed };
}

/** Removes every stored key for the Host; returns the number of entries affected. */
export async function forgetHostKey(file: string, hostName: string, port: number): Promise<number> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw e;
	}
	const result = removeKnownHosts(text, hostName, port);
	if (result.removed === 0) return 0;
	const tmp = `${file}.pi-ssh.tmp`;
	await fs.writeFile(tmp, result.text, { mode: 0o600 });
	await fs.rename(tmp, file);
	return result.removed;
}
