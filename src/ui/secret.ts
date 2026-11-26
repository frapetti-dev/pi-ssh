/** Masked secret prompt as an overlay dialog; `ctx.ui.input` is hidden behind the fullscreen pane. */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JSXNode, KeyEvent, UiEvent } from "@oh-my-pi/pi-tui";
import { OVERLAY_OPTIONS } from "./dialog";
import { LineInput } from "./line-input";
import { bar, button, framed, heading, mount, n, txt, type View } from "./nodes";

export interface SecretAnswer {
	value: string;
	remember: boolean;
}

export function buildSecretComponent(
	refresh: () => void,
	done: (a: SecretAnswer | undefined) => void,
	title: string,
	offerRemember = false,
): View {
	const input = new LineInput("", { masked: true });
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
		refresh();
	};

	return {
		describe(): JSXNode {
			return framed(
				[
					heading("SSH"),
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
			);
		},
		handleEvent(e: UiEvent): void {
			if (e.type !== "action") return;
			if (e.act === "ok") finish(answer());
			else if (e.act === "cancel") finish(undefined);
			else if (e.act === "remember" && offerRemember) toggle();
		},
		handleKey(key: KeyEvent): void {
			if (key.id === "enter") return finish(answer());
			if (key.id === "escape") return finish(undefined);
			if (offerRemember && key.id === "tab") return toggle();
			if (input.handleKey(key)) refresh();
		},
		handlePaste(text: string): void {
			input.paste(text);
			refresh();
		},
	};
}

/** Resolves to the entered secret, or undefined when cancelled. */
export function openSecret(ctx: ExtensionContext, title: string, offerRemember = false): Promise<SecretAnswer | undefined> {
	return ctx.ui.custom<SecretAnswer | undefined>(
		(_ui, _theme, _kb, done) => mount(refresh => buildSecretComponent(refresh, done, title, offerRemember)),
		OVERLAY_OPTIONS,
	);
}
