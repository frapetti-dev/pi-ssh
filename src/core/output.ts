export interface ExecDetails {
	hostId: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	signal?: string;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	approvedBy: "allowlist" | "once" | "host-grant" | "user";
	async?: { state: "running" | "completed" | "failed" | "cancelled"; jobId: string; type: "ssh" };
}

const MAX_LINES = 400;
const KEEP_LINES = 200;
const MAX_BYTES = 65536;
const KEEP_BYTES = 32768;

export function truncateStream(s: string): { text: string; truncated: boolean } {
	let text = s;
	let truncated = false;
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) {
		const omitted = lines.length - 2 * KEEP_LINES;
		text = `${lines.slice(0, KEEP_LINES).join("\n")}\n… [${omitted} lines omitted] …\n${lines.slice(-KEEP_LINES).join("\n")}`;
		truncated = true;
	}
	const buf = Buffer.from(text, "utf8");
	if (buf.length > MAX_BYTES) {
		let headEnd = KEEP_BYTES;
		while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
		let tailStart = buf.length - KEEP_BYTES;
		while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
		const omitted = tailStart - headEnd;
		text = `${buf.subarray(0, headEnd).toString("utf8")}\n… [${omitted} bytes omitted] …\n${buf.subarray(tailStart).toString("utf8")}`;
		truncated = true;
	}
	return { text, truncated };
}

export function exitLabel(d: Pick<ExecDetails, "exitCode" | "signal" | "timedOut">): string {
	if (d.timedOut) return "killed (timeout)";
	if (d.signal) return `signal ${d.signal}`;
	return d.exitCode === null ? "unknown" : String(d.exitCode);
}

export function formatExecText(d: ExecDetails): string {
	const lines = [
		`exit ${exitLabel(d)} · ${(d.durationMs / 1000).toFixed(1)}s · ${d.hostId}`,
		"--- stdout ---",
		d.stdout || "(empty)",
		"--- stderr ---",
		d.stderr || "(empty)",
	];
	if (d.truncated) lines.push("(output truncated)");
	return lines.join("\n");
}

export function humanBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return `${v.toFixed(1)} ${units[u]}`;
}
