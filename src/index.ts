import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HostSpec } from "./core/hosts";
import type { ExecDetails } from "./core/output";
import { createPaneModel } from "./pane-model";
import { createRuntime } from "./runtime";
import { registerExecTool } from "./tools/exec";
import { registerHostsTool } from "./tools/hosts";
import { registerTransferTool } from "./tools/transfer";
import { openPane } from "./ui/pane";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default async function piSsh(pi: ExtensionAPI): Promise<void> {
	const rt = createRuntime();
	/** Ad-hoc Hosts added in the manager (or by `/ssh-manager user@host`); kept for this omp session. */
	const adhoc = new Map<string, HostSpec>();
	/** Last Run result per Host, shown in the manager. */
	const lastRuns = new Map<string, ExecDetails>();

	registerHostsTool(pi, rt);
	await registerExecTool(pi, rt);
	registerTransferTool(pi, rt);

	const completions = (prefix: string, extra: string[] = []) => {
		const items = [...extra, ...rt.configHosts()].filter(h => h.startsWith(prefix));
		return items.length ? items.map(h => ({ value: h, label: h })) : null;
	};

	pi.registerCommand("ssh-manager", {
		description: "Open the SSH connection manager (optionally connect to a host first)",
		getArgumentCompletions: prefix => completions(prefix),
		async handler(args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("pi-ssh needs the interactive UI", "error");
				return;
			}
			rt.bind(ctx);
			const model = createPaneModel(rt, pi, ctx, { adhoc, lastRuns });
			let preselect: string | undefined;
			const input = args.trim();
			if (input) {
				try {
					preselect = model.resolveInput(input);
				} catch (e) {
					ctx.ui.notify(message(e), "error");
				}
			}
			await openPane(ctx, model, { preselect, autoConnect: Boolean(preselect) });
		},
	});

	pi.registerCommand("ssh-disconnect", {
		description: "Close SSH connections (a host, or all)",
		getArgumentCompletions: prefix => completions(prefix, ["all", ...rt.pool.list().map(c => c.spec.id)]),
		async handler(args, ctx) {
			rt.bind(ctx);
			const target = args.trim();
			if (!target || target === "all") {
				const n = rt.pool.list().length;
				rt.pool.closeAll();
				ctx.ui.notify(n ? `Disconnected ${n} connection(s)` : "No SSH connections open", "info");
				return;
			}
			let id = target;
			try {
				id = rt.resolve(target).id;
			} catch {
				// fall through: the raw text may still be a connected id
			}
			if (rt.pool.close(id) || rt.pool.close(target)) ctx.ui.notify(`Disconnected ${target}`, "info");
			else ctx.ui.notify(`Not connected: ${target}`, "warning");
		},
	});

	pi.on("session_shutdown", () => {
		rt.dispose();
		adhoc.clear();
		lastRuns.clear();
	});
}
