/** Masked secret prompt as an overlay dialog; `ctx.ui.input` is hidden behind the fullscreen pane. */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { OVERLAY_OPTIONS, type RenderHost } from "./dialog";
import { withDialog } from "./focus";
import { LineInput } from "./line-input";
import { bar, button, fit, framed, heading, isKey, Memo, n, txt } from "./nodes";

export interface SecretAnswer {
	value: string;
	remember: boolean;
}

export function buildSecretComponent(
	tui: RenderHost,
	done: (a: SecretAnswer | undefined) => void,
	title: string,
	offerRemember = false,
): Component {
	const input = new LineInput("", { masked: true });
	const memo = new Memo();
	let version = 0;
	let finished = false;
	let remember = false;

	const finish = (answer: SecretAnswer | undefined): void => {
		if (finished) return;
		finished = true;
		done(answer);
	};
	const answer = (): SecretAnswer => ({ value: input.value, remember });
	const toggle = (): void => {
		remember = !remember;
		version++;
		tui.requestRender();
	};

	return {
		nativeOverlay: { role: "omp.overlay.pi-ssh", head: "SSH" },
		describe(cx: DescribeContext): NativeNode {
			return memo.get([cx.dark, version], () =>
				framed(
					[
						heading(title),
						input.node({ key: "secret", focused: true }),
						...(offerRemember
							? [
									n(
										"row",
										{ gap: "sm", align: "center" },
										[
											txt("Remember for this omp session"),
											n("badge", {
												text: remember ? "on" : "off",
												tone: remember ? "success" : "muted",
												actions: { click: "remember" },
											}),
											n("kbd", { keys: ["tab"] }),
										],
										"remember",
									),
								]
							: []),
						bar([button("OK", "ok", "enter"), null, button("Cancel", "cancel", "escape")]),
					],
					"md",
				),
			);
		},
		handleNativeEvent(e: NativeUiEvent): void {
			if (e.type !== "action") return;
			if (e.act === "ok") finish(answer());
			else if (e.act === "cancel") finish(undefined);
			else if (e.act === "remember" && offerRemember) toggle();
		},
		handleInput(data: string): void {
			if (isKey(data, "enter")) return finish(answer());
			if (isKey(data, "escape")) return finish(undefined);
			if (offerRemember && isKey(data, "tab")) return toggle();
			if (input.handleInput(data)) {
				version++;
				tui.requestRender();
			}
		},
		render(width: number): readonly string[] {
			return [
				title,
				input.display(),
				...(offerRemember ? [`[${remember ? "x" : " "}] remember for this omp session  [tab] toggle`] : []),
				"[enter] ok  [esc] cancel",
			].map(l => fit(l, width));
		},
		invalidate(): void {},
	};
}

/** Resolves to the entered secret, or undefined when cancelled. */
export function openSecret(ctx: ExtensionContext, title: string, offerRemember = false): Promise<SecretAnswer | undefined> {
	return withDialog(() =>
		ctx.ui.custom<SecretAnswer | undefined>(
			(tui, _theme, _kb, done) => buildSecretComponent(tui, done, title, offerRemember),
			OVERLAY_OPTIONS,
		),
	);
}
