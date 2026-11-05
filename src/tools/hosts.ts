import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Runtime } from "../runtime";
import { n } from "../ui/nodes";

export interface HostRow {
	host: string;
	target: string;
	state: "connected" | "disconnected" | "error";
}

export function listHostRows(rt: Runtime): HostRow[] {
	const connected = new Set(rt.pool.list().map(c => c.spec.id));
	return rt.configHosts().map(alias => {
		try {
			const s = rt.resolve(alias);
			const target = `${s.user}@${s.hostName}:${s.port}${s.proxyJump ? ` via ${s.proxyJump}` : ""}`;
			return { host: alias, target, state: connected.has(s.id) ? "connected" : "disconnected" };
		} catch (e) {
			return { host: alias, target: e instanceof Error ? e.message : String(e), state: "error" };
		}
	});
}

export function registerHostsTool(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerTool({
		name: "ssh_hosts",
		label: "SSH hosts",
		description:
			"List the SSH Hosts configured in ~/.ssh/config (concrete aliases only) with their target and Connection state. " +
			"Any other host can be used ad hoc as user@host[:port].",
		parameters: pi.zod.object({}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			rt.bind(ctx);
			const rows = listHostRows(rt);
			const text = rows.length
				? rows.map(r => `${r.host}\t${r.target}\t${r.state}`).join("\n")
				: "No hosts in ~/.ssh/config.";
			return { content: [{ type: "text", text }], details: { rows } };
		},
		describeCall() {
			return { tool: { title: "SSH hosts", target: "~/.ssh/config", targetKind: "path" } };
		},
		describeResult(result) {
			const d = result.details as { rows: HostRow[] } | undefined;
			if (!d) return undefined;
			return {
				tool: { title: "SSH hosts", meta: [`${d.rows.length} hosts`] },
				body: [
					n("table", {
						cols: [
							{ id: "host", head: "Host" },
							{ id: "target", head: "Target" },
							{ id: "state", head: "State" },
						],
						rows: d.rows.map(r => ({ id: r.host, cells: { host: r.host, target: r.target, state: r.state } })),
					}),
				],
			};
		},
	});
}
