/** Transfer progress widget above the editor: plain rows. */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TransferState, TransferTracker } from "../core/progress";
import { humanBytes } from "../core/output";
import { fit } from "./nodes";

const KEY = "pi-ssh";
const MIN_RENDER_INTERVAL_MS = 200;
const CLEAR_DELAY_MS = 3000;

export const transferArrow = (t: TransferState) => (t.direction === "upload" ? "↑" : "↓");

export function buildProgressComponent(
	ui: { requestRender(): void },
	tracker: TransferTracker,
	listActive: () => TransferState[],
): { render(width: number): readonly string[]; dispose(): void } {
	let lastRender = 0;
	const unsubscribe = tracker.subscribe(() => {
		const now = Date.now();
		if (now - lastRender < MIN_RENDER_INTERVAL_MS) return;
		lastRender = now;
		ui.requestRender();
	});
	return {
		render(width: number): readonly string[] {
			return listActive().map(t => {
				const pct = t.totalBytes > 0 ? Math.floor((t.doneBytes / t.totalBytes) * 100) : 0;
				return fit(`${transferArrow(t)} ${t.label} ${pct}% ${humanBytes(Math.round(t.bytesPerSec))}/s ${t.filesDone}/${t.files} files`, width);
			});
		},
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
				ctx.ui.setWidget(KEY, ui => buildProgressComponent(ui, tracker, () => tracker.active()), { placement: "aboveEditor" });
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
