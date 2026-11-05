/** Masked secret prompt as an overlay dialog; `ctx.ui.input` is hidden behind the fullscreen pane. */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { OVERLAY_OPTIONS, type RenderHost } from "./dialog";
import { withDialog } from "./focus";
import { LineInput } from "./line-input";
import { bar, button, fit, framed, heading, isKey, Memo } from "./nodes";

export function buildSecretComponent(tui: RenderHost, done: (v: string | undefined) => void, title: string): Component {
	const input = new LineInput("", { masked: true });
	const memo = new Memo();
	let version = 0;
	let finished = false;

	const finish = (value: string | undefined): void => {
		if (finished) return;
		finished = true;
		done(value);
	};

	return {
		nativeOverlay: { role: "omp.overlay.pi-ssh", head: "SSH" },
		describe(cx: DescribeContext): NativeNode {
			return memo.get([cx.dark, version], () =>
				framed(
					[
						heading(title),
						input.node({ key: "secret", focused: true }),
						bar([button("OK", "ok", "enter"), null, button("Cancel", "cancel", "escape")]),
					],
					"md",
				),
			);
		},
		handleNativeEvent(e: NativeUiEvent): void {
			if (e.type !== "action") return;
			if (e.act === "ok") finish(input.value);
			else if (e.act === "cancel") finish(undefined);
		},
		handleInput(data: string): void {
			if (isKey(data, "enter")) return finish(input.value);
			if (isKey(data, "escape")) return finish(undefined);
			if (input.handleInput(data)) {
				version++;
				tui.requestRender();
			}
		},
		render(width: number): readonly string[] {
			return [title, input.display(), "[enter] ok  [esc] cancel"].map(l => fit(l, width));
		},
		invalidate(): void {},
	};
}

/** Resolves to the entered secret, or undefined when cancelled. */
export function openSecret(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	return withDialog(() =>
		ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => buildSecretComponent(tui, done, title), OVERLAY_OPTIONS),
	);
}
