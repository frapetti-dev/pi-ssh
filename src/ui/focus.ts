/**
 * Focus hand-back for pi-ssh dialogs opened over the Connection Manager. omp moves focus to the
 * editor when an overlay closes; the pane registers a callback that takes it back once the last
 * pi-ssh dialog is gone.
 */
let refocus: (() => void) | undefined;
let open = 0;

/** Register the pane's refocus callback; the returned function clears it if still current. */
export function registerPane(fn: () => void): () => void {
	refocus = fn;
	return () => {
		if (refocus === fn) refocus = undefined;
	};
}

/** Wrap a dialog's `ctx.ui.custom` call so the pane regains focus after the last one closes. */
export async function withDialog<T>(show: () => Promise<T>): Promise<T> {
	open++;
	try {
		return await show();
	} finally {
		if (--open === 0) refocus?.();
	}
}
