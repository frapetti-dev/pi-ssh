import * as fs from "node:fs";
import * as path from "node:path";
import SSHConfig from "ssh-config";

export interface HostSpec {
	/** Alias, or `user@hostName:port` for ad-hoc hosts. */
	id: string;
	alias?: string;
	hostName: string;
	user: string;
	port: number;
	identityFiles: string[];
	proxyJump?: string;
}

function parseConfig(configText: string): SSHConfig {
	try {
		return SSHConfig.parse(configText);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`~/.ssh/config parse error: ${msg}`);
	}
}

function hostValues(value: unknown): string[] {
	if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
	if (!Array.isArray(value)) return [];
	return value.flatMap(v => {
		if (typeof v === "string") return hostValues(v);
		if (v && typeof v === "object" && "val" in v && typeof v.val === "string") return hostValues(v.val);
		return [];
	});
}

/** Concrete (non-pattern) aliases from top-level Host sections, in file order. */
export function listConfigHosts(configText: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const node of parseConfig(configText)) {
		if (!("param" in node) || node.param.toLowerCase() !== "host") continue;
		for (const v of hostValues(node.value)) {
			if (/[*?!]/.test(v) || seen.has(v)) continue;
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/** Case-insensitive lookup into a computed config object. */
function pick(computed: Record<string, unknown>, key: string): unknown {
	const lower = key.toLowerCase();
	for (const k of Object.keys(computed)) if (k.toLowerCase() === lower) return computed[k];
	return undefined;
}

function first(v: unknown): string | undefined {
	if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
	return v === undefined || v === null ? undefined : String(v);
}

export function expandHome(p: string, home: string): string {
	return p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? path.join(home, p.slice(2)) : p;
}

function identityFiles(raw: unknown, home: string): string[] {
	const list = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
	if (list.length) return list.map(p => expandHome(p, home));
	return ["id_ed25519", "id_ecdsa", "id_rsa"].map(n => path.join(home, ".ssh", n)).filter(p => fs.existsSync(p));
}

function jump(raw: unknown): string | undefined {
	const v = first(raw)?.trim();
	if (!v || v.toLowerCase() === "none") return undefined;
	if (v.includes(",")) throw new Error(`Only single-level ProxyJump is supported (got: ${v})`);
	return v;
}

const ADHOC = /^(?:([^@\s]+)@)?([^@\s:]+|\[[^\]]+\])(?::(\d+))?$/;

export function resolveHost(
	input: string,
	configText: string,
	defaults: { user: string; home: string },
): HostSpec {
	const config = parseConfig(configText);
	const trimmed = input.trim();
	if (listConfigHosts(configText).includes(trimmed)) {
		const c = config.compute(trimmed) as Record<string, unknown>;
		return {
			id: trimmed,
			alias: trimmed,
			hostName: first(pick(c, "HostName")) ?? trimmed,
			user: first(pick(c, "User")) ?? defaults.user,
			port: Number(first(pick(c, "Port")) ?? 22),
			identityFiles: identityFiles(pick(c, "IdentityFile"), defaults.home),
			proxyJump: jump(pick(c, "ProxyJump")),
		};
	}
	const m = ADHOC.exec(trimmed);
	if (!m) throw new Error(`Invalid host: ${input}. Use a ~/.ssh/config alias or user@host[:port]`);
	const hostName = m[2].startsWith("[") ? m[2].slice(1, -1) : m[2];
	const c = config.compute(hostName) as Record<string, unknown>;
	const user = m[1] ?? first(pick(c, "User")) ?? defaults.user;
	const port = m[3] ? Number(m[3]) : 22;
	return {
		id: `${user}@${hostName}:${port}`,
		hostName,
		user,
		port,
		identityFiles: identityFiles(pick(c, "IdentityFile"), defaults.home),
		proxyJump: jump(pick(c, "ProxyJump")),
	};
}

/** Raw form strings for a new Host; the caller trims them. */
export interface NewHost {
	alias: string;
	hostName: string;
	user: string;
	port: string;
	identityFile: string;
	proxyJump: string;
}

/** First failing validation message, or undefined when the Host is acceptable. */
export function validateNewHost(h: NewHost, save: boolean, existingAliases: readonly string[]): string | undefined {
	if (save && !h.alias) return "Alias is required to save to ~/.ssh/config";
	if (h.alias && !/^[A-Za-z0-9._-]+$/.test(h.alias)) return "Alias may only contain letters, digits, '.', '_' and '-'";
	if (save && existingAliases.includes(h.alias)) return `Alias already exists in ~/.ssh/config: ${h.alias}`;
	if (!h.hostName) return "HostName is required";
	if (/\s/.test(h.hostName)) return "HostName must not contain spaces";
	if (/[\s@]/.test(h.user)) return "User must not contain spaces or '@'";
	if (h.port) {
		const n = Number(h.port);
		if (!/^\d+$/.test(h.port) || n < 1 || n > 65535) return "Port must be a number from 1 to 65535";
	}
	if (h.proxyJump.includes(",")) return "Only single-level ProxyJump is supported";
	if (/\s/.test(h.proxyJump)) return "ProxyJump must not contain spaces";
	return undefined;
}

export function configBlock(h: NewHost): string {
	const lines = [`Host ${h.alias}`, `    HostName ${h.hostName}`];
	if (h.user) lines.push(`    User ${h.user}`);
	if (h.port) lines.push(`    Port ${h.port}`);
	if (h.identityFile) lines.push(`    IdentityFile ${/\s/.test(h.identityFile) ? `"${h.identityFile}"` : h.identityFile}`);
	if (h.proxyJump) lines.push(`    ProxyJump ${h.proxyJump}`);
	return `${lines.join("\n")}\n`;
}

export async function appendConfigHost(file: string, h: NewHost): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	let existing = "";
	try {
		existing = await fs.promises.readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const prefix = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	await fs.promises.appendFile(file, prefix + configBlock(h), { mode: 0o600 });
}
