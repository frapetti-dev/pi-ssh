/** Single-line text editing state for pane forms and the secret dialog. */
import type { NativeNode } from "@oh-my-pi/pi-tui";
import { isKey, n } from "./nodes";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

export class LineInput {
	value: string;
	cursor: number;

	constructor(
		initial = "",
		private readonly opts: { masked?: boolean } = {},
	) {
		this.value = initial;
		this.cursor = initial.length;
	}

	/** Returns true when the key was consumed. */
	handleInput(data: string): boolean {
		const text = data.startsWith(PASTE_START) ? data.slice(PASTE_START.length).replace(PASTE_END, "") : data;
		const flat = text.replace(/[\r\n]/g, "");
		if (flat && PRINTABLE.test(flat)) {
			this.value = this.value.slice(0, this.cursor) + flat + this.value.slice(this.cursor);
			this.cursor += flat.length;
			return true;
		}
		if (isKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
			}
			return true;
		}
		if (isKey(data, "delete")) {
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
			return true;
		}
		if (isKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return true;
		}
		if (isKey(data, "right")) {
			this.cursor = Math.min(this.value.length, this.cursor + 1);
			return true;
		}
		if (isKey(data, "home")) {
			this.cursor = 0;
			return true;
		}
		if (isKey(data, "end")) {
			this.cursor = this.value.length;
			return true;
		}
		if (isKey(data, "ctrl+u")) {
			this.value = "";
			this.cursor = 0;
			return true;
		}
		return false;
	}

	display(): string {
		return this.opts.masked ? "•".repeat(this.value.length) : this.value;
	}

	node(p: { key: string; focused: boolean; placeholder?: string }): NativeNode {
		return n(
			"input",
			{ text: this.display(), cursor: p.focused ? this.cursor : undefined, placeholder: p.placeholder, readonly: !p.focused },
			undefined,
			p.key,
		);
	}
}
