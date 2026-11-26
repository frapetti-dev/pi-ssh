import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { LineInput } from "../src/ui/line-input";

const k = (id: string, text?: string) => ({ id, text, kind: "press", raw: "" }) as KeyEvent;

describe("LineInput", () => {
	test("inserts at the cursor", () => {
		const input = new LineInput("ac");
		expect(input.handleKey(k("left"))).toBe(true);
		expect(input.handleKey(k("b", "b"))).toBe(true);
		expect(input.value).toBe("abc");
		expect(input.cursor).toBe(2);
	});

	test("backspace at position 0 is a no-op; delete removes under the cursor", () => {
		const input = new LineInput("ab");
		input.handleKey(k("home"));
		expect(input.handleKey(k("backspace"))).toBe(true);
		expect(input.value).toBe("ab");
		input.handleKey(k("delete"));
		expect(input.value).toBe("b");
		expect(input.cursor).toBe(0);
	});

	test("paste drops newlines", () => {
		const input = new LineInput();
		input.paste("ab\r\ncd");
		expect(input.value).toBe("abcd");
	});

	test("unrelated keys are not consumed", () => {
		const input = new LineInput("x");
		expect(input.handleKey(k("enter", "\r"))).toBe(false);
		expect(input.handleKey(k("escape"))).toBe(false);
		expect(input.handleKey(k("tab", "\t"))).toBe(false);
		expect(input.handleKey(k("ctrl+c", "c"))).toBe(false);
	});

	test("ctrl+u clears", () => {
		const input = new LineInput("abc");
		input.handleKey(k("ctrl+u"));
		expect(input).toMatchObject({ value: "", cursor: 0 });
	});

	test("masked display hides the value", () => {
		const input = new LineInput("abc", { masked: true });
		expect(input.display()).toBe("•••");
		expect(input.value).toBe("abc");
	});
});
