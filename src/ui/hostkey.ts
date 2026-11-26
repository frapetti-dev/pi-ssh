import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HostSpec } from "../core/hosts";
import { hostField } from "../core/known-hosts";
import { buildDialog, OVERLAY_OPTIONS } from "./dialog";
import { mount, n, prose, type View } from "./nodes";

export interface HostKeyInfo {
	host: HostSpec;
	type: string;
	fingerprint: string;
	knownTypes: string[];
}

export function buildHostKeyComponent(done: (trust: boolean) => void, info: HostKeyInfo): View {
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
		},
		done,
	);
}

export async function openHostKey(ctx: ExtensionContext, info: HostKeyInfo): Promise<boolean> {
	const result = await ctx.ui.custom<boolean>((_ui, _theme, _kb, done) => mount(() => buildHostKeyComponent(done, info)), OVERLAY_OPTIONS);
	return result === true;
}
