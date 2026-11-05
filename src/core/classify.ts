export type Classification = { allowed: true } | { allowed: false; reason: string };

export const BUILTIN_ALLOW: readonly string[] = [
	"ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "find", "stat", "file", "df", "du", "free",
	"uptime", "uname", "whoami", "id", "hostname", "pwd", "which", "ps", "date", "echo", "sort", "uniq", "cut",
	"journalctl", "systemctl status", "systemctl is-active", "systemctl list-units",
	"git status", "git log", "git diff", "git show",
];

/**
 * Deny rule semantics: the first word must equal the command word; the remaining words must then appear
 * in order anywhere later (`*` is accepted as an explicit gap marker and ignored); the last word of a
 * multi-word rule matches as a prefix, so `--vacuum` matches `--vacuum-size=1G`.
 */
export const BUILTIN_DENY: readonly string[] = [
	"find * -exec", "find * -execdir", "find * -delete", "find * -ok", "find * -fprint",
	"journalctl * --vacuum", "journalctl * --rotate", "journalctl * --flush",
	"git diff * --output", "git log * --output", "git show * --output",
	"sort * -o", "sort * --output", "file * -C",
];

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Lexed = { ok: true; segments: string[][] } | { ok: false; reason: string };

const reject = (token: string): Lexed => ({ ok: false, reason: `contains "${token}"` });

/** Minimal POSIX lexer: splits on unquoted `|`, rejects any other shell control syntax. */
function lex(command: string): Lexed {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		const next = command[i + 1];
		if (c === "\\") {
			word += next ?? "\\";
			inWord = true;
			i += 2;
		} else if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) return { ok: false, reason: "unterminated quote" };
			word += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
		} else if (c === '"') {
			i++;
			let closed = false;
			while (i < command.length) {
				const d = command[i];
				if (d === '"') {
					closed = true;
					i++;
					break;
				}
				if (d === "\\") {
					const e = command[i + 1];
					if (e !== undefined && '$`"\\\n'.includes(e)) {
						word += e;
						i += 2;
					} else {
						word += "\\";
						i++;
					}
					continue;
				}
				if (d === "`") return reject("`");
				if (d === "$" && command[i + 1] === "(") return reject("$(");
				if (d === "$" && command[i + 1] === "{") return reject("${");
				word += d;
				i++;
			}
			if (!closed) return { ok: false, reason: "unterminated quote" };
			inWord = true;
		} else if (c === "|") {
			if (next === "|") return reject("||");
			endWord();
			segments.push(words);
			words = [];
			i++;
		} else if (c === "$" && (next === "(" || next === "{")) {
			return reject(`$${next}`);
		} else if (c === "\n" || c === "\r") {
			return reject("newline");
		} else if (c === ";" || c === "&" || c === ">" || c === "<" || c === "`" || c === "(" || c === ")") {
			return reject(c);
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else {
			word += c;
			inWord = true;
			i++;
		}
	}
	endWord();
	segments.push(words);
	return { ok: true, segments };
}

function words(rule: string): string[] {
	return rule.trim().split(/\s+/).filter(Boolean);
}

function matchesAllow(rule: string, seg: string[]): boolean {
	const r = words(rule);
	return r.length > 0 && r.length <= seg.length && r.every((w, i) => seg[i] === w);
}

function matchesDeny(rule: string, seg: string[]): boolean {
	const r = words(rule).filter(w => w !== "*");
	if (r.length === 0 || seg[0] !== r[0]) return false;
	let j = 1;
	for (let k = 1; k < r.length; k++) {
		const last = k === r.length - 1;
		while (j < seg.length && !(last ? seg[j].startsWith(r[k]) : seg[j] === r[k])) j++;
		if (j >= seg.length) return false;
		j++;
	}
	return true;
}

export function classify(command: string, rules: { allow: readonly string[]; deny: readonly string[] }): Classification {
	const lexed = lex(command);
	if (!lexed.ok) return { allowed: false, reason: lexed.reason };
	for (const seg of lexed.segments) {
		if (seg.length === 0) return { allowed: false, reason: "empty pipeline segment" };
		if (ENV_ASSIGN.test(seg[0])) return { allowed: false, reason: "sets environment variable" };
		if (["sudo", "su", "doas"].includes(seg[0])) return { allowed: false, reason: "privilege escalation" };
		const denied = rules.deny.find(rule => matchesDeny(rule, seg));
		if (denied !== undefined) return { allowed: false, reason: `matches deny rule "${denied}"` };
		if (!rules.allow.some(rule => matchesAllow(rule, seg))) {
			return { allowed: false, reason: `"${seg[0]}" is not on the read-only allowlist` };
		}
	}
	return { allowed: true };
}
