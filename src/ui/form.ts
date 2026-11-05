/** Inline form for the Connection Manager: text fields and toggles, native tree plus ANSI lines. */
import type { NativeNode } from "@oh-my-pi/pi-tui";
import { LineInput } from "./line-input";
import { bar, button, heading, isKey, n, prose, txt } from "./nodes";

export type Field =
	| { kind: "text"; id: string; label: string; input: LineInput; placeholder?: string }
	| { kind: "toggle"; id: string; label: string; on: boolean };

export type FormResult = "submit" | "cancel" | "handled" | "ignored";

export function textField(id: string, label: string, placeholder?: string, initial = ""): Field {
	return { kind: "text", id, label, input: new LineInput(initial), placeholder };
}

export class Form {
	error?: string;
	focus = 0;

	constructor(
		readonly title: string,
		private readonly fields: Field[],
		private readonly submitLabel: string,
	) {}

	handleInput(data: string): FormResult {
		const result = this.route(data);
		if (result !== "ignored") this.error = undefined;
		return result;
	}

	private route(data: string): FormResult {
		if (isKey(data, "escape")) return "cancel";
		if (isKey(data, "tab") || isKey(data, "down")) return this.move(1);
		if (isKey(data, "shift+tab") || isKey(data, "up")) return this.move(-1);
		if (isKey(data, "enter")) return this.focus === this.fields.length - 1 ? "submit" : this.move(1);
		const field = this.fields[this.focus];
		if (field?.kind === "toggle") {
			if (isKey(data, "space")) {
				field.on = !field.on;
				return "handled";
			}
			return "ignored";
		}
		return field?.input.handleInput(data) ? "handled" : "ignored";
	}

	private move(delta: number): FormResult {
		this.focus = (this.focus + delta + this.fields.length) % this.fields.length;
		return "handled";
	}

	handleAction(act: string): FormResult {
		if (act === "form-submit") return "submit";
		if (act === "form-cancel") return "cancel";
		const [verb, id] = act.split(":");
		const index = this.fields.findIndex(f => f.id === id);
		const field = this.fields[index];
		if (!field) return "ignored";
		if (verb === "field") {
			this.focus = index;
			return "handled";
		}
		if (verb === "toggle" && field.kind === "toggle") {
			field.on = !field.on;
			this.error = undefined;
			return "handled";
		}
		return "ignored";
	}

	/** Trimmed value of a text field. */
	text(id: string): string {
		const f = this.fields.find(x => x.id === id);
		return f?.kind === "text" ? f.input.value.trim() : "";
	}

	on(id: string): boolean {
		const f = this.fields.find(x => x.id === id);
		return f?.kind === "toggle" && f.on;
	}

	describe(): NativeNode {
		const rows = this.fields.map((f, i) =>
			n(
				"row",
				{ gap: "sm", align: "center" },
				[
					prose(f.label, { actions: { click: `field:${f.id}` } }),
					f.kind === "text"
						? f.input.node({ key: `${f.id}-input`, focused: i === this.focus, placeholder: f.placeholder })
						: n("badge", { text: f.on ? "on" : "off", tone: f.on ? "success" : "muted", actions: { click: `toggle:${f.id}` } }),
				],
				f.id,
			),
		);
		return n(
			"col",
			{ gap: "sm" },
			[
				heading(this.title),
				...rows,
				...(this.error ? [txt([{ t: this.error, s: "error" }])] : []),
				bar([button(this.submitLabel, "form-submit", "enter"), null, button("Cancel", "form-cancel", "escape")], "form-actions"),
			],
			"form",
		);
	}

	ansi(): string[] {
		const lines = this.fields.map((f, i) => {
			const mark = i === this.focus ? "> " : "  ";
			return `${mark}${f.label}: ${f.kind === "text" ? f.input.display() : f.on ? "[x]" : "[ ]"}`;
		});
		if (this.error) lines.push(`  ${this.error}`);
		return lines;
	}
}
