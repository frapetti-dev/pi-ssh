import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import type { HostSpec } from "../core/hosts";
import { humanBytes } from "../core/output";
import { buildDialog, type DialogButton, OVERLAY_OPTIONS, type RenderHost } from "./dialog";
import { withDialog } from "./focus";
import { n, prose } from "./nodes";

export type ApprovalDecision = "once" | "host" | "deny";

export type ApprovalRequest =
	| { kind: "command"; host: HostSpec; command: string; cwd?: string; reason: string }
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

export function buildApprovalComponent(
	_tui: RenderHost,
	done: (d: ApprovalDecision) => void,
	req: ApprovalRequest,
): Component {
	const buttons: (DialogButton<ApprovalDecision> | null)[] = [
		{ label: "Allow once", act: "once", key: "y", value: "once" },
	];
	if (req.kind === "command") buttons.push({ label: "Always on this host", act: "host", key: "a", value: "host" });
	buttons.push(null, { label: "Deny", act: "deny", key: "escape", value: "deny" });

	if (req.kind === "command") {
		const kv = [{ k: "host", v: target(req.host) }];
		if (req.cwd) kv.push({ k: "cwd", v: req.cwd });
		return buildDialog(
			{
				head: "SSH approval",
				title: `Run command on ${req.host.id}?`,
				body: [n("kv", { items: kv }), n("code", { text: req.command, lang: "bash" }), prose(req.reason)],
				buttons,
				ansi: [`host: ${target(req.host)}`, ...(req.cwd ? [`cwd: ${req.cwd}`] : []), `$ ${req.command}`, req.reason],
				aliases: { n: "deny" },
			},
			done,
		);
	}
	const verb = req.direction === "upload" ? "Upload to" : "Download from";
	const arrow = req.direction === "upload" ? `${req.local} -> ${req.remote}` : `${req.remote} -> ${req.local}`;
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
			ansi: [`host: ${target(req.host)}`, arrow, `${req.files} files (${humanBytes(req.totalBytes)}), ${req.existing} overwrites`, req.reason],
			aliases: { n: "deny" },
		},
		done,
	);
}

/** Resolves to `deny` when the overlay is dismissed without a choice. */
export async function openApproval(ctx: ExtensionContext, req: ApprovalRequest): Promise<ApprovalDecision> {
	const result = await withDialog(() =>
		ctx.ui.custom<ApprovalDecision>((tui, _theme, _kb, done) => buildApprovalComponent(tui, done, req), OVERLAY_OPTIONS),
	);
	return result ?? "deny";
}
