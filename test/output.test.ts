import { describe, expect, test } from "bun:test";
import { formatExecText, truncateStream } from "../src/core/output";

describe("truncateStream", () => {
	test("keeps first 200 and last 200 lines", () => {
		const input = Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n");
		const { text, truncated } = truncateStream(input);
		const lines = text.split("\n");
		expect(truncated).toBe(true);
		expect(lines[0]).toBe("line0");
		expect(lines[199]).toBe("line199");
		expect(lines[200]).toBe("… [600 lines omitted] …");
		expect(lines[201]).toBe("line800");
		expect(lines.at(-1)).toBe("line999");
		expect(lines).toHaveLength(401);
	});

	test("caps a huge single line on code-point boundaries", () => {
		const input = "é".repeat(60000);
		const { text, truncated } = truncateStream(input);
		expect(truncated).toBe(true);
		expect(text).toContain("bytes omitted");
		expect(text).not.toContain("\uFFFD");
		expect(Buffer.byteLength(text)).toBeLessThan(65536 + 100);
	});

	test("leaves small output untouched", () => {
		expect(truncateStream("a\nb")).toEqual({ text: "a\nb", truncated: false });
	});
});

describe("formatExecText", () => {
	const d = {
		hostId: "web",
		command: "x",
		exitCode: 3,
		timedOut: false,
		durationMs: 1234,
		stdout: "",
		stderr: "boom",
		truncated: false,
		approvedBy: "allowlist" as const,
	};
	test("formats header and streams", () => {
		expect(formatExecText(d)).toBe("exit 3 · 1.2s · web\n--- stdout ---\n(empty)\n--- stderr ---\nboom");
	});
	test("labels timeouts, signals and truncation", () => {
		expect(formatExecText({ ...d, exitCode: null, timedOut: true, truncated: true })).toStartWith("exit killed (timeout)");
		expect(formatExecText({ ...d, exitCode: null, signal: "TERM" })).toStartWith("exit signal TERM");
		expect(formatExecText({ ...d, truncated: true })).toEndWith("(output truncated)");
	});
});
