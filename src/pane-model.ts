/** Runtime-backed PaneModel for the Connection Manager. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { BUILTIN_ALLOW, BUILTIN_DENY } from "./core/classify";
import { appendConfigHost, expandHome, type HostSpec, type NewHost, validateNewHost } from "./core/hosts";
import { forgetHostKey, type KnownHostEntry, listKnownHosts } from "./core/known-hosts";
import type { ExecDetails } from "./core/output";
import { loadRules } from "./core/settings";
import { planTransfer } from "./core/transfer";
import type { Runtime } from "./runtime";
import { runCommand } from "./tools/exec";
import { executeTransfer, summarize } from "./tools/transfer";
import type { PaneConnection, PaneHost, PaneModel, PlannedTransfer, RulesView } from "./ui/pane-model";
import { tern, ternAvailable } from "./ui/tern";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const EMPTY_RULES = '{\n  "allow": [],\n  "deny": []\n}\n';

export interface PaneSession {
	/** Ad-hoc Hosts added in the pane (or by `/ssh-manager user@host`); kept for this omp session. */
	adhoc: Map<string, HostSpec>;
	/** Last `Run` result per Host id. */
	lastRuns: Map<string, ExecDetails>;
}

export function createPaneModel(
	rt: Runtime,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: PaneSession,
): PaneModel & { resolveInput(input: string): string } {
	const { adhoc, lastRuns } = session;
	const listeners = new Set<() => void>();
	const emit = (): void => {
		for (const cb of listeners) cb();
	};

	const specFor = (id: string): HostSpec => adhoc.get(id) ?? rt.pool.list().find(c => c.spec.id === id)?.spec ?? rt.resolve(id);

	return {
		hosts(): PaneHost[] {
			const entries = new Map<string, PaneHost>();
			for (const alias of rt.configHosts()) {
				try {
					entries.set(alias, { id: alias, spec: rt.resolve(alias), adhoc: false });
				} catch (e) {
					entries.set(alias, { id: alias, error: message(e), adhoc: false });
				}
			}
			for (const spec of [...adhoc.values(), ...rt.pool.list().map(c => c.spec)]) {
				if (!entries.has(spec.id)) entries.set(spec.id, { id: spec.id, spec, adhoc: !spec.alias });
			}
			return [...entries.values()];
		},

		resolveInput(input: string): string {
			const spec = rt.resolve(input);
			if (!spec.alias) adhoc.set(spec.id, spec);
			return spec.id;
		},

		connection(id: string): PaneConnection | undefined {
			const c = rt.pool.list().find(x => x.spec.id === id);
			return c && { connectedAt: c.connectedAt, hostKey: c.hostKey };
		},
		connecting: id => rt.pool.connecting().includes(id),
		grants: () => [...rt.grants].sort(),
		transfers: () => rt.tracker.list(),
		lastRun: id => lastRuns.get(id),

		subscribe(cb: () => void): () => void {
			listeners.add(cb);
			const offPool = rt.pool.onChange(cb);
			const offTracker = rt.tracker.subscribe(cb);
			return () => {
				listeners.delete(cb);
				offPool();
				offTracker();
			};
		},

		async knownHostEntries(id: string): Promise<KnownHostEntry[]> {
			const spec = specFor(id);
			let text: string;
			try {
				text = await fs.promises.readFile(rt.knownHostsPath, "utf8");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw e;
			}
			return listKnownHosts(text, spec.hostName, spec.port);
		},

		async rules(): Promise<RulesView> {
			const loaded = await loadRules(rt.rulesPath);
			const rows = (list: string[], builtin: readonly string[]) => list.map(rule => ({ rule, builtin: builtin.includes(rule) }));
			return {
				path: rt.rulesPath,
				exists: fs.existsSync(rt.rulesPath),
				warning: loaded.warning,
				allow: rows(loaded.allow, BUILTIN_ALLOW),
				deny: rows(loaded.deny, BUILTIN_DENY),
			};
		},

		async connect(id: string): Promise<void> {
			await rt.pool.get(specFor(id), rt.prompter(ctx));
		},
		disconnect(id: string): void {
			rt.pool.close(id);
		},
		revokeGrant(id: string): void {
			rt.grants.delete(id);
			emit();
		},

		async run(id, command, opts): Promise<ExecDetails> {
			const details = await runCommand(rt, ctx, specFor(id), command, {
				approvedBy: "user",
				signal: opts.signal,
				onPartial: opts.onPartial,
			});
			lastRuns.set(id, details);
			emit();
			return details;
		},

		async planTransfer(id, direction, local, remote): Promise<PlannedTransfer> {
			const conn = await rt.pool.get(specFor(id), rt.prompter(ctx));
			const plan = await planTransfer(conn, direction, local, remote, ctx.cwd);
			return { plan, existing: plan.files.filter(f => f.exists).length };
		},
		async executeTransfer(id, planned): Promise<string> {
			const conn = await rt.pool.get(specFor(id), rt.prompter(ctx));
			return summarize(await executeTransfer(rt, conn, planned.plan));
		},

		async forgetHostKey(id: string): Promise<number> {
			const spec = specFor(id);
			return forgetHostKey(rt.knownHostsPath, spec.hostName, spec.port);
		},

		async addHost(input: NewHost, save: boolean): Promise<string> {
			const problem = validateNewHost(input, save, rt.configHosts());
			if (problem) throw new Error(problem);
			if (save) {
				await appendConfigHost(rt.sshConfigPath, input);
				emit();
				return input.alias;
			}
			const { user, hostName, port, identityFile, proxyJump } = input;
			const spec = rt.resolve(`${user ? `${user}@` : ""}${hostName}${port ? `:${port}` : ""}`);
			if (identityFile) spec.identityFiles = [expandHome(identityFile, os.homedir())];
			if (proxyJump) {
				rt.resolve(proxyJump);
				spec.proxyJump = proxyJump;
			}
			adhoc.set(spec.id, spec);
			emit();
			return spec.id;
		},

		canShell: ternAvailable,
		async openShell(id: string): Promise<void> {
			const spec = specFor(id);
			await tern(pi, ctx, [
				"split",
				process.env.TERN_PANE ?? "",
				"right",
				"--",
				"ssh",
				...(spec.alias ? [spec.alias] : ["-p", String(spec.port), `${spec.user}@${spec.hostName}`]),
			]);
		},

		canOpenRules: ternAvailable,
		async openRulesFile(): Promise<void> {
			if (!fs.existsSync(rt.rulesPath)) {
				await fs.promises.mkdir(path.dirname(rt.rulesPath), { recursive: true });
				await fs.promises.writeFile(rt.rulesPath, EMPTY_RULES);
			}
			await tern(pi, ctx, ["open", "--split", "right", rt.rulesPath]);
		},
	};
}
