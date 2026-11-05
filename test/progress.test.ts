import { describe, expect, test } from "bun:test";
import { TransferTracker } from "../src/core/progress";

const init = { hostId: "h", direction: "upload" as const, label: "x", totalBytes: 10, files: 1 };

describe("TransferTracker", () => {
	test("keeps the 20 newest finished transfers plus running ones, newest first", () => {
		const t = new TransferTracker();
		const running = t.start(init);
		const finished: number[] = [];
		for (let i = 0; i < 25; i++) {
			const id = t.start(init);
			t.finish(id);
			finished.push(id);
		}
		const list = t.list();
		expect(list).toHaveLength(21);
		expect(list.map(x => x.id)).toEqual([...list.map(x => x.id)].sort((a, b) => b - a));
		expect(list.some(x => x.id === running && x.state === "running")).toBe(true);
		expect(list.some(x => x.id === finished[4])).toBe(false);
		expect(list.some(x => x.id === finished[5])).toBe(true);
		expect(list.find(x => x.id === finished[24])?.finishedAt).toBeNumber();
		expect(t.active().map(x => x.id)).toEqual([running]);
	});
});
