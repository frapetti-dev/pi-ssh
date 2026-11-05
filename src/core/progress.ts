export interface TransferState {
	id: number;
	hostId: string;
	direction: "upload" | "download";
	label: string;
	totalBytes: number;
	doneBytes: number;
	files: number;
	filesDone: number;
	startedAt: number;
	bytesPerSec: number;
	state: "running" | "done" | "error";
	error?: string;
	finishedAt?: number;
}

/** Minimum interval over which a rate sample is computed. */
const RATE_WINDOW_MS = 200;
/** Finished transfers retained for the Connection Manager. */
const MAX_FINISHED = 20;

export class TransferTracker {
	private readonly transfers = new Map<number, TransferState>();
	private readonly samples = new Map<number, { bytes: number; at: number }>();
	private readonly subs = new Set<() => void>();
	private nextId = 1;

	start(init: { hostId: string; direction: "upload" | "download"; label: string; totalBytes: number; files: number }): number {
		const id = this.nextId++;
		const now = Date.now();
		this.transfers.set(id, { ...init, id, doneBytes: 0, filesDone: 0, startedAt: now, bytesPerSec: 0, state: "running" });
		this.samples.set(id, { bytes: 0, at: now });
		this.emit();
		return id;
	}

	update(id: number, p: { doneBytes: number; filesDone: number }): void {
		const t = this.transfers.get(id);
		const s = this.samples.get(id);
		if (!t || !s) return;
		const now = Date.now();
		t.doneBytes = p.doneBytes;
		t.filesDone = p.filesDone;
		if (now - s.at >= RATE_WINDOW_MS) {
			t.bytesPerSec = ((p.doneBytes - s.bytes) * 1000) / (now - s.at);
			s.bytes = p.doneBytes;
			s.at = now;
		}
		this.emit();
	}

	finish(id: number, error?: string): void {
		const t = this.transfers.get(id);
		if (!t) return;
		t.state = error ? "error" : "done";
		t.error = error;
		t.bytesPerSec = 0;
		if (!error) t.doneBytes = t.totalBytes;
		this.samples.delete(id);
		t.finishedAt = Date.now();
		const finished = [...this.transfers.values()].filter(x => x.state !== "running").sort((a, b) => a.id - b.id);
		for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) this.transfers.delete(old.id);
		this.emit();
	}

	subscribe(cb: () => void): () => void {
		this.subs.add(cb);
		return () => this.subs.delete(cb);
	}

	active(): TransferState[] {
		return [...this.transfers.values()].filter(t => t.state === "running");
	}

	/** Every retained transfer, newest first. */
	list(): TransferState[] {
		return [...this.transfers.values()].sort((a, b) => b.id - a.id);
	}

	private emit(): void {
		for (const cb of this.subs) cb();
	}
}
