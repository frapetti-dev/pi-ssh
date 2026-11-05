import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_ALLOW, BUILTIN_DENY } from "./classify";

export const defaultRulesPath = (): string => path.join(os.homedir(), ".omp", "agent", "pi-ssh.json");

export interface Rules {
	allow: string[];
	deny: string[];
	warning?: string;
}

function stringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every(x => typeof x === "string");
}

/** Built-in rules merged with the user's `pi-ssh.json`. Invalid user files are ignored with a warning. */
export async function loadRules(file: string): Promise<Rules> {
	const builtin: Rules = { allow: [...BUILTIN_ALLOW], deny: [...BUILTIN_DENY] };
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return builtin;
		return { ...builtin, warning: `pi-ssh.json ignored: ${e instanceof Error ? e.message : String(e)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { ...builtin, warning: `pi-ssh.json ignored: invalid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...builtin, warning: "pi-ssh.json ignored: top level must be an object" };
	}
	const allow = "allow" in parsed ? parsed.allow : [];
	const deny = "deny" in parsed ? parsed.deny : [];
	if (!stringArray(allow) || !stringArray(deny)) {
		return { ...builtin, warning: "pi-ssh.json ignored: allow and deny must be arrays of strings" };
	}
	return {
		allow: [...new Set([...builtin.allow, ...allow])],
		deny: [...new Set([...builtin.deny, ...deny])],
	};
}
