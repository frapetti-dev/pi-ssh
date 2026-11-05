import { describe, expect, test } from "bun:test";
import { LineInput } from "../src/ui/line-input";

describe("LineInput", () => {
	test("inserts at the cursor", () => {
		const input = new LineInput("ac");
		expect(input.handleInput("\x1b[D")).toBe(true);
		expect(input.handleInput("b")).toBe(true);
		expect(input.value).toBe("abc");
		expect(input.cursor).toBe(2);
	});

	test("backspace at position 0 is a no-op; delete removes under the cursor", () => {
		const input = new LineInput("ab");
		input.handleInput("\x1b[H");
		expect(input.handleInput("\x7f")).toBe(true);
		expect(input.value).toBe("ab");
		input.handleInput("\x1b[3~");
		expect(input.value).toBe("b");
		expect(input.cursor).toBe(0);
	});

	test("bracketed paste drops newlines", () => {
		const input = new LineInput();
		input.handleInput("\x1b[200~ab\ncd\x1b[201~");
		expect(input.value).toBe("abcd");
	});

	test("unrelated keys are not consumed", () => {
		const input = new LineInput("x");
		expect(input.handleInput("\r")).toBe(false);
		expect(input.handleInput("\x1b")).toBe(false);
		expect(input.handleInput("\t")).toBe(false);
	});

	test("ctrl+u clears", () => {
		const input = new LineInput("abc");
		input.handleInput("\x15");
		expect(input).toMatchObject({ value: "", cursor: 0 });
	});

	test("masked display hides the value", () => {
		const input = new LineInput("abc", { masked: true });
		expect(input.display()).toBe("•••");
		expect(input.value).toBe("abc");
	});
});
