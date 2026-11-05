/** Transfer progress widget above the editor: native rows with an ANSI fallback. */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeNode } from "@oh-my-pi/pi-tui";
import type { TransferState, TransferTracker } from "../core/progress";
import { humanBytes } from "../core/output";
import type { RenderHost } from "./dialog";
import { fit, n, txt } from "./nodes";

const KEY = "pi-ssh";
const MIN_RENDER_INTERVAL_MS = 200;
const CLEAR_DELAY_MS = 3000;

export const transferArrow = (t: TransferState) => (t.direction === "upload" ? "↑" : "↓");

export function buildProgressComponent(tui: RenderHost, tracker: TransferTracker, listActive: () => TransferState[]): Component & { dispose(): void } {
	let version = 0;
	let lastRender = 0;
	let cached: { version: number; node: NativeNode } | undefined;
	const unsubscribe = tracker.subscribe(() => {
		const now = Date.now();
		if (now - lastRender < MIN_RENDER_INTERVAL_MS) return;
		lastRender = now;
		version++;
		tui.requestRender();
	});
	return {
		describe(_cx: DescribeContext): NativeNode {
			if (cached?.version === version) return cached.node;
			const rows = listActive().map(t =>
				n(
					"row",
					{ gap: "sm", align: "center" },
					[
						n("spinner", { style: "orbit" }),
						txt(`${transferArrow(t)} ${t.label}`),
						n("progress", { value: t.totalBytes > 0 ? t.doneBytes / t.totalBytes : null }),
						n("rate", { value: t.bytesPerSec, unit: "B/s" }),
						txt(`${t.filesDone}/${t.files}`),
					],
					`t${t.id}`,
				),
			);
			const node = n("col", { gap: "xs" }, rows);
			cached = { version, node };
			return node;
		},
		render(width: number): readonly string[] {
			return listActive().map(t => {
				const pct = t.totalBytes > 0 ? Math.floor((t.doneBytes / t.totalBytes) * 100) : 0;
				return fit(`${transferArrow(t)} ${t.label} ${pct}% ${humanBytes(Math.round(t.bytesPerSec))}/s ${t.filesDone}/${t.files} files`, width);
			});
		},
		invalidate(): void {},
		dispose(): void {
			unsubscribe();
		},
	};
}

/** Show the widget while transfers run; clear it 3 s after the last one finishes. Idempotent per ctx. */
export function syncProgressWidget(ctx: ExtensionContext, tracker: TransferTracker): () => void {
	let shown = false;
	let clearTimer: Timer | undefined;
	const cancelClear = () => {
		if (clearTimer !== undefined) ctx.clearTimer(clearTimer);
		clearTimer = undefined;
	};
	const hide = () => {
		cancelClear();
		if (!shown) return;
		shown = false;
		ctx.ui.setWidget(KEY, undefined);
	};
	const unsubscribe = tracker.subscribe(() => {
		if (tracker.active().length > 0) {
			cancelClear();
			if (!shown) {
				shown = true;
				ctx.ui.setWidget(KEY, tui => buildProgressComponent(tui, tracker, () => tracker.active()), { placement: "aboveEditor" });
			}
		} else if (shown && clearTimer === undefined) {
			clearTimer = ctx.setTimeout(hide, CLEAR_DELAY_MS);
		}
	});
	return () => {
		unsubscribe();
		hide();
	};
}
