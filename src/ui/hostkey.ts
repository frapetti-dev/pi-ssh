import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import type { HostSpec } from "../core/hosts";
import { hostField } from "../core/known-hosts";
import { buildDialog, OVERLAY_OPTIONS, type RenderHost } from "./dialog";
import { withDialog } from "./focus";
import { n, prose } from "./nodes";

export interface HostKeyInfo {
	host: HostSpec;
	type: string;
	fingerprint: string;
	knownTypes: string[];
}

export function buildHostKeyComponent(
	_tui: RenderHost,
	done: (trust: boolean) => void,
	info: HostKeyInfo,
): Component {
	const field = hostField(info.host.hostName, info.host.port);
	const note =
		"First connection to this host. Verify the fingerprint out of band before trusting." +
		(info.knownTypes.length ? ` Known with other key types: ${info.knownTypes.join(", ")}.` : "");
	return buildDialog<boolean>(
		{
			head: "Unknown host key",
			title: `Trust ${field}?`,
			body: [
				n("kv", {
					items: [
						{ k: "type", v: [{ t: info.type, s: "mono" }] },
						{ k: "fingerprint", v: [{ t: info.fingerprint, s: "mono" }] },
					],
				}),
				prose(note),
			],
			buttons: [
				{ label: "Trust and save", act: "trust", key: "t", value: true },
				null,
				{ label: "Cancel", act: "cancel", key: "escape", value: false },
			],
			ansi: [`type: ${info.type}`, `fingerprint: ${info.fingerprint}`, note],
		},
		done,
	);
}

export async function openHostKey(ctx: ExtensionContext, info: HostKeyInfo): Promise<boolean> {
	const result = await withDialog(() =>
		ctx.ui.custom<boolean>((tui, _theme, _kb, done) => buildHostKeyComponent(tui, done, info), OVERLAY_OPTIONS),
	);
	return result === true;
}
