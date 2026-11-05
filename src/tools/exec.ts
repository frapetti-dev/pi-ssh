import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { classify } from "../core/classify";
import type { HostSpec } from "../core/hosts";
import { type ExecDetails, exitLabel, formatExecText, truncateStream } from "../core/output";
import { loadRules } from "../core/settings";
import type { Runtime } from "../runtime";
import { openApproval } from "../ui/approval";
import { n } from "../ui/nodes";

const DEFAULT_TIMEOUT_SEC = 120;
const UPDATE_INTERVAL_MS = 250;

/** Single-quote `s` for a POSIX shell. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: text }, isError: true as const };
}

function shape(
	d: Pick<ExecDetails, "hostId" | "command" | "cwd" | "approvedBy">,
	raw: { code: number | null; signal?: string; timedOut: boolean; stdout: string; stderr: string; durationMs: number },
): ExecDetails {
	const out = truncateStream(raw.stdout);
	const err = truncateStream(raw.stderr);
	return {
		...d,
		exitCode: raw.code,
		signal: raw.signal,
		timedOut: raw.timedOut,
		durationMs: raw.durationMs,
		stdout: out.text,
		stderr: err.text,
		truncated: out.truncated || err.truncated,
	};
}

export interface RunOptions {
	cwd?: string;
	timeoutSec?: number;
	signal?: AbortSignal;
	approvedBy: ExecDetails["approvedBy"];
	onPartial?(d: ExecDetails): void;
}

/** Run an already-approved command on `spec`. Throws on connection failure. */
export async function runCommand(
	rt: Runtime,
	ctx: ExtensionContext,
	spec: HostSpec,
	command: string,
	opts: RunOptions,
): Promise<ExecDetails> {
	const conn = await rt.pool.get(spec, rt.prompter(ctx));
	const base = { hostId: spec.id, command, cwd: opts.cwd, approvedBy: opts.approvedBy };
	let stdout = "";
	let stderr = "";
	let lastUpdate = 0;
	const started = Date.now();
	const result = await conn.exec(opts.cwd ? `cd -- ${shQuote(opts.cwd)} && ${command}` : command, {
		signal: opts.signal,
		timeoutMs: (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
		onData: (which, chunk) => {
			if (which === "stdout") stdout += chunk;
			else stderr += chunk;
			const now = Date.now();
			if (!opts.onPartial || now - lastUpdate < UPDATE_INTERVAL_MS) return;
			lastUpdate = now;
			opts.onPartial(shape(base, { code: null, timedOut: false, stdout, stderr, durationMs: now - started }));
		},
	});
	return shape(base, result);
}

let lastWarning: string | undefined;

export function registerExecTool(pi: ExtensionAPI, rt: Runtime): void {
	const z = pi.zod;
	pi.registerTool({
		name: "ssh_exec",
		label: "SSH exec",
		description:
			"Run one non-interactive command on a remote Host over SSH and return exit status, stdout and stderr. " +
			"Read-only allowlisted commands (ls, cat, grep, git status, ...) run immediately; any other command, " +
			"pipelines with redirects or command substitution included, needs the user's approval first. " +
			"There is no interactive shell, no PTY and no stdin. Output is truncated to the first and last 200 lines.",
		parameters: z.object({
			host: z.string().describe("~/.ssh/config alias or user@host[:port]"),
			command: z.string().describe("Shell command to run on the Host"),
			cwd: z.string().optional().describe("Remote working directory"),
			timeoutSec: z.number().int().min(1).max(900).optional().describe("Timeout in seconds (default 120, max 900)"),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, params, signal, onUpdate, ctx) {
			rt.bind(ctx);
			let spec: HostSpec;
			try {
				spec = rt.resolve(params.host);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}

			const rules = await loadRules(rt.rulesPath);
			if (rules.warning && rules.warning !== lastWarning && ctx.hasUI) ctx.ui.notify(rules.warning, "warning");
			lastWarning = rules.warning;

			const verdict = classify(params.command, rules);
			let approvedBy: ExecDetails["approvedBy"] = "allowlist";
			if (!verdict.allowed) {
				if (rt.grants.has(spec.id)) approvedBy = "host-grant";
				else if (!ctx.hasUI) {
					return errorResult(`Remote command needs user approval but no UI is available: ${verdict.reason}`);
				} else {
					const decision = await openApproval(ctx, {
						kind: "command",
						host: spec,
						command: params.command,
						cwd: params.cwd,
						reason: verdict.reason,
					});
					if (decision === "deny") return errorResult(`User denied remote command on ${spec.id}.`);
					if (decision === "host") rt.grants.add(spec.id);
					approvedBy = decision;
				}
			}

			try {
				const details = await runCommand(rt, ctx, spec, params.command, {
					cwd: params.cwd,
					timeoutSec: params.timeoutSec,
					signal,
					approvedBy,
					onPartial: partial =>
						onUpdate?.({ content: [{ type: "text", text: formatExecText(partial) }], details: partial }),
				});
				return { content: [{ type: "text", text: formatExecText(details) }], details };
			} catch (e) {
				return errorResult(`SSH to ${spec.id} failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		},
		describeCall(args) {
			return {
				tool: {
					title: "SSH",
					target: args.command,
					targetKind: "command",
					badges: [{ text: args.host, tone: "accent" }],
				},
			};
		},
		describeResult(result, _opts, args) {
			const d = result.details as ExecDetails | { error: string } | undefined;
			if (!d || !("hostId" in d)) return undefined;
			const failed = d.exitCode !== 0 || d.timedOut;
			return {
				tool: {
					title: "SSH",
					target: d.command,
					targetKind: "command",
					meta: [d.hostId, `exit ${exitLabel(d)}`, `${(d.durationMs / 1000).toFixed(1)}s`],
					badges: [{ text: d.approvedBy, tone: d.approvedBy === "allowlist" ? "success" : "warning" }],
					exit: d.exitCode === 0 ? undefined : d.exitCode,
					note: d.timedOut ? "timed out" : d.truncated ? "truncated" : undefined,
				},
				open: failed,
				body: [
					...(d.stdout ? [n("ansi", { text: d.stdout })] : []),
					...(d.stderr ? [n("section", { head: "stderr" }, [n("ansi", { text: d.stderr })], "stderr")] : []),
				],
			};
		},
	});
}
