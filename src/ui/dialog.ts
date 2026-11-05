/**
 * Shared modal dialog: a native `describe()` tree (heading, body, action bar) plus an ANSI `render()`
 * fallback and a keyboard twin for every button. Used by approval, host-key and output overlays.
 */
import type { Component, DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { bar, button, fit, framed, heading, isKey, Memo } from "./nodes";

export interface DialogButton<T> {
	label: string;
	/** Action name (native click) and display key (keyboard twin). */
	act: string;
	key: string;
	/** Result passed to `done` when chosen. */
	value: T;
}

export interface DialogSpec<T> {
	/** Overlay frame head. */
	head: string;
	title: string;
	/** Native body nodes between the title and the action bar. */
	body: readonly NativeChild[];
	/** `null` renders a growing spacer. */
	buttons: readonly (DialogButton<T> | null)[];
	/** ANSI fallback rows between the title and the key hint; fitted to width by the dialog. */
	ansi: readonly string[];
	/** Extra keys (besides each button's own) mapped to an action name. */
	aliases?: Record<string, string>;
}

export interface RenderHost {
	requestRender(): void;
}

export const OVERLAY_OPTIONS = { overlay: true, overlayOptions: { width: "80%" } } as const;

export function buildDialog<T>(spec: DialogSpec<T>, done: (value: T) => void): Component {
	const memo = new Memo();
	let finished = false;
	const real = spec.buttons.filter((b): b is DialogButton<T> => b !== null);

	const choose = (act: string | undefined): void => {
		const b = real.find(x => x.act === act);
		if (!b || finished) return;
		finished = true;
		done(b.value);
	};

	const hint = real.map(b => `[${b.key === "escape" ? "esc" : b.key}] ${b.label.toLowerCase()}`).join("  ");
	return {
		nativeOverlay: { role: "omp.overlay.pi-ssh", head: spec.head },
		describe(cx: DescribeContext): NativeNode {
			return memo.get([cx.dark], () =>
				framed(
					[
						heading(spec.title),
						...spec.body,
						bar(spec.buttons.map(b => (b ? button(b.label, b.act, b.key) : null))),
					],
					"md",
				),
			);
		},
		handleNativeEvent(e: NativeUiEvent): void {
			if (e.type === "action") choose(e.act);
		},
		handleInput(data: string): void {
			const alias = spec.aliases?.[data];
			if (alias) return choose(alias);
			choose(real.find(b => data === b.key || isKey(data, b.key))?.act);
		},
		render(width: number): readonly string[] {
			return [spec.title, ...spec.ansi, hint].map(l => fit(l, width));
		},
		invalidate(): void {},
	};
}
