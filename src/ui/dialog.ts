/** Shared modal dialog: a `describe()` tree (heading, body, action bar) plus a keyboard twin for every button. */
import type { JSXNode, KeyEvent, UiEvent } from "@oh-my-pi/pi-tui";
import { bar, button, framed, heading, type View } from "./nodes";

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
	body: readonly JSXNode[];
	/** `null` renders a growing spacer. */
	buttons: readonly (DialogButton<T> | null)[];
	/** Extra keys (besides each button's own) mapped to an action name. */
	aliases?: Record<string, string>;
}

export const OVERLAY_OPTIONS = { overlay: true } as const;

export function buildDialog<T>(spec: DialogSpec<T>, done: (value: T) => void): View {
	let finished = false;
	const real = spec.buttons.filter((b): b is DialogButton<T> => b !== null);

	const choose = (act: string | undefined): void => {
		const b = real.find(x => x.act === act);
		if (!b || finished) return;
		finished = true;
		done(b.value);
	};

	return {
		describe(): JSXNode {
			return framed(
				[
					heading(spec.head),
					heading(spec.title),
					...spec.body,
					bar(spec.buttons.map(b => (b ? button(b.label, b.act, b.key) : null))),
				],
				"md",
			);
		},
		handleEvent(e: UiEvent): void {
			if (e.type === "action") choose(e.act);
		},
		handleKey(key: KeyEvent): void {
			const alias = spec.aliases?.[key.id];
			if (alias) return choose(alias);
			choose(real.find(b => key.id === b.key)?.act);
		},
	};
}
