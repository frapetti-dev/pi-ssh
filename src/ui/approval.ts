import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HostSpec } from "../core/hosts";
import { humanBytes } from "../core/output";
import { buildDialog, type DialogButton, OVERLAY_OPTIONS } from "./dialog";
import { mount, n, prose, type View } from "./nodes";

export type ApprovalDecision = "once" | "host" | "deny";

export type ApprovalRequest =
	| { kind: "command"; host: HostSpec; command: string; cwd?: string; reason: string; sudo?: boolean }
	| {
			kind: "transfer";
			host: HostSpec;
			direction: "upload" | "download";
			local: string;
			remote: string;
			files: number;
			totalBytes: number;
			existing: number;
			reason: string;
	  };

const target = (h: HostSpec) => `${h.user}@${h.hostName}:${h.port}`;

export function buildApprovalComponent(done: (d: ApprovalDecision) => void, req: ApprovalRequest): View {
	const buttons: (DialogButton<ApprovalDecision> | null)[] = [
		{ label: "Allow once", act: "once", key: "y", value: "once" },
	];
	if (req.kind === "command" && !req.sudo) {
		buttons.push({ label: "Always on this host", act: "host", key: "a", value: "host" });
	}
	buttons.push(null, { label: "Deny", act: "deny", key: "escape", value: "deny" });

	if (req.kind === "command") {
		const kv = [{ k: "host", v: target(req.host) }];
		if (req.sudo) kv.push({ k: "as", v: "root (sudo)" });
		if (req.cwd) kv.push({ k: "cwd", v: req.cwd });
		return buildDialog(
			{
				head: "SSH approval",
				title: req.sudo ? `Run command as root on ${req.host.id}?` : `Run command on ${req.host.id}?`,
				body: [n("kv", { items: kv }), n("code", { text: req.command, lang: "bash" }), prose(req.reason)],
				buttons,
				aliases: { n: "deny" },
			},
			done,
		);
	}
	const verb = req.direction === "upload" ? "Upload to" : "Download from";
	const kv = [
		{ k: "host", v: target(req.host) },
		{ k: "files", v: `${req.files} (${humanBytes(req.totalBytes)})` },
		{ k: "overwrites", v: String(req.existing) },
		{ k: "local", v: req.local },
		{ k: "remote", v: req.remote },
	];
	return buildDialog(
		{
			head: "SSH approval",
			title: `${verb} ${req.host.id}?`,
			body: [n("kv", { items: kv }), prose(req.reason)],
			buttons,
			aliases: { n: "deny" },
		},
		done,
	);
}

/** Resolves to `deny` when the overlay is dismissed without a choice. */
export async function openApproval(ctx: ExtensionContext, req: ApprovalRequest): Promise<ApprovalDecision> {
	const result = await ctx.ui.custom<ApprovalDecision>((_ui, _theme, _kb, done) => mount(() => buildApprovalComponent(done, req)), OVERLAY_OPTIONS);
	return result ?? "deny";
}
