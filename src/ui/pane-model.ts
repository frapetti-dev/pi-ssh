/** Contract between the Connection Manager pane and the runtime; the UI depends only on this. */
import type { HostSpec, NewHost } from "../core/hosts";
import type { KnownHostEntry } from "../core/known-hosts";
import type { ExecDetails } from "../core/output";
import type { TransferState } from "../core/progress";
import type { TransferPlan } from "../core/transfer";

export interface PaneHost {
	id: string;
	spec?: HostSpec;
	error?: string;
	/** Not from ~/.ssh/config. */
	adhoc: boolean;
}

export interface PaneConnection {
	connectedAt: number;
	hostKey: { type: string; fingerprint: string };
}

export interface RuleRow {
	rule: string;
	builtin: boolean;
}

export interface RulesView {
	path: string;
	exists: boolean;
	warning?: string;
	allow: RuleRow[];
	deny: RuleRow[];
}

export interface PlannedTransfer {
	plan: TransferPlan;
	/** Files that would overwrite an existing target. */
	existing: number;
}

export interface PaneModel {
	hosts(): PaneHost[];
	connection(id: string): PaneConnection | undefined;
	connecting(id: string): boolean;
	grants(): string[];
	/** Every retained Transfer, newest first. */
	transfers(): TransferState[];
	lastRun(id: string): ExecDetails | undefined;
	subscribe(cb: () => void): () => void;
	knownHostEntries(id: string): Promise<KnownHostEntry[]>;
	rules(): Promise<RulesView>;
	connect(id: string): Promise<void>;
	disconnect(id: string): void;
	revokeGrant(id: string): void;
	run(id: string, command: string, opts: { signal: AbortSignal; onPartial(d: ExecDetails): void }): Promise<ExecDetails>;
	planTransfer(id: string, direction: "upload" | "download", local: string, remote: string): Promise<PlannedTransfer>;
	/** Resolves to the summary text. */
	executeTransfer(id: string, planned: PlannedTransfer): Promise<string>;
	forgetHostKey(id: string): Promise<number>;
	/** Resolves to the new Host id. */
	addHost(input: NewHost, save: boolean): Promise<string>;
	canShell(): boolean;
	openShell(id: string): Promise<void>;
	canOpenRules(): boolean;
	openRulesFile(): Promise<void>;
}
