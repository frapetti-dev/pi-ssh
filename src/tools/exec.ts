import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SUDO_PROMPT } from "../core/connections";
import { classify } from "../core/classify";
import type { HostSpec } from "../core/hosts";
import { type ExecDetails, formatExecText, truncateStream } from "../core/output";
import { loadRules } from "../core/settings";
import type { Runtime } from "../runtime";
import { openApproval } from "../ui/approval";
import { openSecret } from "../ui/secret";

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
	sudoPassword?(): Promise<string | undefined>;
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
	const inner = opts.cwd ? `cd -- ${shQuote(opts.cwd)} && ${command}` : command;
	const remote = opts.sudoPassword ? `sudo -S -p ${shQuote(SUDO_PROMPT)} -- sh -c ${shQuote(inner)}` : inner;
	const result = await conn.exec(remote, {
		signal: opts.signal,
		timeoutMs: (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
		sudoPassword: opts.sudoPassword,
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

/** Shape of the internal omp modules used below; they have no public typings. */
interface JobManager {
	atCapacity: boolean;
	register(
		type: string,
		label: string,
		run: (job: {
			jobId: string;
			signal: AbortSignal;
			reportProgress(text: string, details: { output: string }): unknown;
		}) => Promise<string>,
		opts: { ownerId?: string; foreground: boolean },
	): string;
	releaseForegroundJob(id: string): void;
	backgroundJob(id: string): void;
	cancel(id: string): void;
}
interface JobsModule {
	AsyncJobManager: { instance(): JobManager | undefined };
	formatAsyncJobLabel(label: string): string;
	raceJobSettlement<T>(p: Promise<T>, waitMs: number, signal?: AbortSignal): Promise<T | { kind: "running" } | { kind: "aborted" }>;
	resolveAutoBackgroundWaitMs(thresholdMs: number, timeoutMs?: number): number;
}
interface SettingsRegistry {
	lookup(id: string): { get(settings: unknown): unknown } | undefined;
}
interface ShellRenderer {
	describeCall: unknown;
	describeResult(result: unknown, opts: unknown, args: unknown): unknown;
}
interface BashUi {
	createShellRenderer(opts: {
		resolveTitle(a?: ExecArgs): string;
		resolveCommand(a?: ExecArgs): string | undefined;
		resolveCwd(a?: ExecArgs): string | undefined;
		showHeader: boolean;
	}): ShellRenderer;
}
interface ExecArgs {
	host?: string;
	command?: string;
	cwd?: string;
	sudo?: boolean;
}
interface ExecResult {
	content: { type: "text"; text: string }[];
	details: ExecDetails | { error: string };
	isError?: true;
}

export async function registerExecTool(pi: ExtensionAPI, rt: Runtime): Promise<void> {
	const z = pi.zod;
	// omp has no public job/renderer API; these internal modules may move, so each degrades instead of breaking the extension.
	const [jobs, registry, bashUi] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/async").then(m => m as JobsModule, () => undefined),
		import("@oh-my-pi/pi-coding-agent/config/registry").then(m => m as SettingsRegistry, () => undefined),
		import("@oh-my-pi/pi-tui/tools/bash").then(m => m as BashUi, () => undefined),
	]);
	const setting = <T>(id: string): T | undefined =>
		pi.pi?.settings ? (registry?.lookup(id)?.get(pi.pi.settings) as T | undefined) : undefined;
	const shell = bashUi?.createShellRenderer({
		resolveTitle: a => (a?.host ? `SSH · ${a.host}${a.sudo ? " (sudo)" : ""}` : "SSH"),
		resolveCommand: a => a?.command,
		resolveCwd: a => a?.cwd,
		showHeader: false,
	});
	const card = (result: ExecResult, opts: unknown, args: unknown) => {
		const d = result.details;
		if (!("hostId" in d)) return shell!.describeResult(result, opts, args); // errors render as a failed bash run
		const text = [d.stdout.trimEnd(), d.stderr.trimEnd()].filter(Boolean).join("\n");
		return shell!.describeResult(
			{
				content: [{ type: "text", text }],
				isError: result.isError === true || d.signal !== undefined,
				details: { exitCode: d.exitCode ?? undefined, timedOut: d.timedOut, wallTimeMs: d.durationMs, async: d.async },
			},
			opts,
			args,
		);
	};
	pi.registerTool({
		name: "ssh_exec",
		label: "SSH exec",
		description:
			"Run one non-interactive command on a remote Host over SSH and return exit status, stdout and stderr. " +
			"Read-only allowlisted commands (ls, cat, grep, git status, ...) run immediately; any other command, " +
			"pipelines with redirects or command substitution included, needs the user's approval first. " +
			"There is no interactive shell, no PTY and no stdin. Output is truncated to the first and last 200 lines. " +
			"Set sudo: true to run as root; never prefix the command with sudo yourself (there is no TTY for its password prompt). Every sudo command needs the user's approval. " +
			"Set async: true to run it in the background, like bash.",
		parameters: z.object({
			host: z.string().describe("~/.ssh/config alias or user@host[:port]"),
			command: z.string().describe("Shell command to run on the Host"),
			cwd: z.string().optional().describe("Remote working directory"),
			timeoutSec: z.number().int().min(1).max(900).optional().describe("Timeout in seconds (default 120, max 900)"),
			sudo: z
				.boolean()
				.optional()
				.describe("Run the command as root via sudo; the user is asked for the sudo password if the Host needs one"),
			async: z
				.boolean()
				.optional()
				.describe(
					"Run in the background: returns a job id at once and the result arrives as a follow-up. Long commands are backgrounded automatically. Monitor with read proc://<id>, block with wait, cancel by writing proc://<id>/kill.",
				),
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

			const verdict = params.sudo
				? { allowed: false as const, reason: "runs as root via sudo" }
				: classify(params.command, rules);
			let approvedBy: ExecDetails["approvedBy"] = "allowlist";
			if (!verdict.allowed) {
				if (rt.grants.has(spec.id) && !params.sudo) approvedBy = "host-grant";
				else if (!ctx.hasUI) {
					return errorResult(`Remote command needs user approval but no UI is available: ${verdict.reason}`);
				} else {
					const decision = await openApproval(ctx, {
						kind: "command",
						host: spec,
						command: params.command,
						cwd: params.cwd,
						sudo: params.sudo,
						reason: verdict.reason,
					});
					if (decision === "deny") return errorResult(`User denied remote command on ${spec.id}.`);
					if (decision === "host") rt.grants.add(spec.id);
					approvedBy = decision;
				}
			}

			const run = async (jobSignal: AbortSignal | undefined, onPartial: (d: ExecDetails) => void): Promise<ExecResult> => {
				try {
					const details = await runCommand(rt, ctx, spec, params.command, {
						cwd: params.cwd,
						timeoutSec: params.timeoutSec,
						signal: jobSignal,
						approvedBy,
						sudoPassword: params.sudo
							? async () => {
									const cached = rt.sudoPasswords.get(spec.id);
									if (cached !== undefined) return cached;
									const answer = await openSecret(ctx, `sudo password for ${spec.user}@${spec.hostName}`, true);
									if (answer?.remember) rt.sudoPasswords.set(spec.id, answer.value);
									return answer?.value;
								}
							: undefined,
						onPartial,
					});
					if (details.signal === "SUDO_DENIED") {
						rt.sudoPasswords.delete(spec.id);
						return errorResult(`sudo rejected the password on ${spec.id}; the command did not run.`);
					}
					if (details.signal === "SUDO_CANCELLED") {
						return errorResult(`User cancelled the sudo password prompt on ${spec.id}.`);
					}
					return { content: [{ type: "text", text: formatExecText(details) }], details };
				} catch (e) {
					return errorResult(`SSH to ${spec.id} failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			};
			const toUpdate = (d: ExecDetails) => ({ content: [{ type: "text" as const, text: formatExecText(d) }], details: d });
			const empty = shape(
				{ hostId: spec.id, command: params.command, cwd: params.cwd, approvedBy },
				{ code: null, timedOut: false, stdout: "", stderr: "", durationMs: 0 },
			);

			const startJob = (mgr: JobManager, foreground: boolean) => {
				let backgrounded = !foreground;
				let latest: ExecDetails | undefined;
				const done = Promise.withResolvers<ExecResult>();
				const label = jobs!.formatAsyncJobLabel(`${spec.id}: ${params.command}`);
				const jobId = mgr.register(
					"ssh",
					label,
					async ({ jobId, signal: jobSignal, reportProgress }) => {
						const emit = (d: ExecDetails, state: NonNullable<ExecDetails["async"]>["state"]) => {
							latest = d;
							const text = formatExecText(d);
							void reportProgress(text, { output: text });
							onUpdate?.(toUpdate(backgrounded ? { ...d, async: { state, jobId, type: "ssh" } } : d));
						};
						const result = await run(jobSignal, d => emit(d, "running"));
						done.resolve(result);
						const d = result.details;
						const text = result.content[0].text;
						const failed = !("hostId" in d) || d.exitCode !== 0 || d.timedOut || d.signal !== undefined;
						if ("hostId" in d) emit(d, jobSignal.aborted ? "cancelled" : failed ? "failed" : "completed");
						if (failed) throw new Error(text);
						return text;
					},
					{ ownerId: ctx.agent?.id, foreground },
				);
				return {
					jobId,
					completion: done.promise,
					latest: () => latest,
					background: () => {
						backgrounded = true;
					},
				};
			};
			const notice = (jobId: string) =>
				`Backgrounded as job ${jobId} (killed once it has run ${params.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s in total); its result arrives as a follow-up the moment it finishes. Do NOT poll: read proc://${jobId} for progress, call wait to block on it, or write proc://${jobId}/kill to cancel.`;
			const backgroundResult = (jobId: string, d: ExecDetails): ExecResult => ({
				content: [{ type: "text", text: d.stdout || d.stderr ? `${formatExecText(d)}\n\n${notice(jobId)}` : notice(jobId) }],
				details: { ...d, async: { state: "running", jobId, type: "ssh" } },
			});

			const mgr = jobs?.AsyncJobManager.instance();
			if (params.async) {
				if (!mgr) return errorResult("Background jobs are unavailable in this omp build.");
				if (setting<boolean>("async.enabled") === false) return errorResult("Async execution is disabled. Enable async.enabled to use async mode.");
				if (mgr.atCapacity) return errorResult("Background job limit reached. Wait for running jobs to finish or cancel one.");
				try {
					await rt.pool.get(spec, rt.prompter(ctx)); // host-key/credential prompts happen in the call, not later
				} catch (e) {
					return errorResult(`SSH to ${spec.id} failed: ${e instanceof Error ? e.message : String(e)}`);
				}
				const job = startJob(mgr, false);
				return backgroundResult(job.jobId, empty);
			}
			if (mgr && !mgr.atCapacity && setting<boolean>("bash.autoBackground.enabled") !== false) {
				const timeoutMs = (params.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
				const waitMs = jobs!.resolveAutoBackgroundWaitMs(Math.floor(setting<number>("bash.autoBackground.thresholdMs") ?? 60_000), timeoutMs);
				const job = startJob(mgr, waitMs > 0);
				if (waitMs === 0) return backgroundResult(job.jobId, empty);
				const r = await jobs!.raceJobSettlement(job.completion.then(result => ({ kind: "completed" as const, result })), waitMs, signal);
				if (r.kind === "completed") {
					mgr.releaseForegroundJob(job.jobId);
					return r.result;
				}
				if (r.kind === "aborted") {
					mgr.cancel(job.jobId);
					mgr.releaseForegroundJob(job.jobId);
					return errorResult(`Remote command on ${spec.id} aborted.`);
				}
				job.background();
				mgr.backgroundJob(job.jobId);
				return backgroundResult(job.jobId, job.latest() ?? empty);
			}
			return run(signal, d => onUpdate?.(toUpdate(d)));
		},
		...(shell && { describeCall: shell.describeCall, describeResult: card, mergeCallAndResult: true, inline: true }),
	});
}
