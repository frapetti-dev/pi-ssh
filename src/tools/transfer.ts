import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connection } from "../core/connections";
import type { HostSpec } from "../core/hosts";
import { humanBytes } from "../core/output";
import { planTransfer, runTransfer, type TransferPlan } from "../core/transfer";
import type { Runtime } from "../runtime";
import { openApproval } from "../ui/approval";
import { n, txt } from "../ui/nodes";
import { errorResult } from "./exec";

const MAX_ITEMS = 50;

export interface TransferItem {
	path: string;
	status: "done" | "dropped";
}

export interface TransferDetails {
	hostId: string;
	direction: "upload" | "download";
	local: string;
	remote: string;
	filesDone: number;
	files: number;
	bytes: number;
	skipped: string[];
	/** Capped at 50 entries; `files` has the full count. */
	items: TransferItem[];
}

function details(spec: HostSpec, plan: TransferPlan, filesDone: number, bytes: number): TransferDetails {
	return {
		hostId: spec.id,
		direction: plan.direction,
		local: plan.localRoot,
		remote: plan.remoteRoot,
		filesDone,
		files: plan.files.length,
		bytes,
		skipped: plan.skipped,
		items: plan.files.slice(0, MAX_ITEMS).map((f, i) => ({
			path: plan.direction === "upload" ? f.local : f.remote,
			status: i < filesDone ? "done" : "dropped",
		})),
	};
}

/** Run a planned transfer, reporting through the tracker (progress widget). Throws on failure or abort. */
export async function executeTransfer(
	rt: Runtime,
	conn: Connection,
	plan: TransferPlan,
	signal?: AbortSignal,
	onProgress?: (filesDone: number, doneBytes: number) => void,
): Promise<TransferDetails> {
	const id = rt.tracker.start({
		hostId: conn.spec.id,
		direction: plan.direction,
		label: path.basename(plan.localRoot),
		totalBytes: plan.totalBytes,
		files: plan.files.length,
	});
	let filesDone = 0;
	try {
		const result = await runTransfer(
			conn,
			plan,
			p => {
				filesDone = p.filesDone;
				rt.tracker.update(id, p);
				onProgress?.(p.filesDone, p.doneBytes);
			},
			signal,
		);
		rt.tracker.finish(id);
		return details(conn.spec, plan, result.filesDone, result.bytes);
	} catch (e) {
		rt.tracker.finish(id, e instanceof Error ? e.message : String(e));
		throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
			transfer: details(conn.spec, plan, filesDone, 0),
		});
	}
}

export function summarize(d: TransferDetails): string {
	const verb = d.direction === "upload" ? "Uploaded" : "Downloaded";
	const arrow = d.direction === "upload" ? `${d.local} → ${d.remote}` : `${d.remote} → ${d.local}`;
	const lines = [`${verb} ${d.filesDone} files (${humanBytes(d.bytes)}) ${arrow}`];
	if (d.skipped.length) lines.push(`Skipped (symlinks/special): ${d.skipped.join(", ")}`);
	return lines.join("\n");
}

const outsideCwd = (cwd: string, target: string): boolean => {
	const rel = path.relative(cwd, target);
	return rel.startsWith("..") || path.isAbsolute(rel);
};

export function registerTransferTool(pi: ExtensionAPI, rt: Runtime): void {
	const z = pi.zod;
	pi.registerTool({
		name: "ssh_transfer",
		label: "SSH transfer",
		description:
			"Copy a file or directory tree between the local machine and a remote Host over SFTP (scp -r semantics: " +
			"an existing destination directory receives the source under its own name). Symlinks and special files are skipped. " +
			"Uploads always need the user's approval; downloads need it when they overwrite local files or land outside the working directory.",
		parameters: z.object({
			host: z.string().describe("~/.ssh/config alias or user@host[:port]"),
			direction: z.enum(["upload", "download"]),
			localPath: z.string().describe("Local path (relative to the working directory)"),
			remotePath: z.string().describe("Remote path (relative to the remote home, or ~/x, or absolute)"),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, params, signal, onUpdate, ctx) {
			rt.bind(ctx);
			let spec: HostSpec;
			try {
				spec = rt.resolve(params.host);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
			let conn: Connection;
			let plan: TransferPlan;
			try {
				conn = await rt.pool.get(spec, rt.prompter(ctx));
				plan = await planTransfer(conn, params.direction, params.localPath, params.remotePath, ctx.cwd);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}

			const existing = plan.files.filter(f => f.exists).length;
			let reason: string | undefined;
			if (plan.direction === "upload") reason = "Uploads always need approval.";
			else if (existing > 0) reason = `${existing} local file(s) would be overwritten.`;
			else if (outsideCwd(ctx.cwd, plan.localRoot)) reason = "The download target is outside the working directory.";
			if (reason) {
				if (!ctx.hasUI) return errorResult(`Transfer needs user approval but no UI is available: ${reason}`);
				const decision = await openApproval(ctx, {
					kind: "transfer",
					host: spec,
					direction: plan.direction,
					local: plan.localRoot,
					remote: plan.remoteRoot,
					files: plan.files.length,
					totalBytes: plan.totalBytes,
					existing,
					reason,
				});
				if (decision === "deny") return errorResult("User denied transfer.");
			}

			try {
				const d = await executeTransfer(rt, conn, plan, signal, (filesDone, doneBytes) => {
					const partial = details(spec, plan, filesDone, doneBytes);
					onUpdate?.({ content: [{ type: "text", text: `${filesDone}/${plan.files.length} files, ${humanBytes(doneBytes)}` }], details: partial });
				});
				return { content: [{ type: "text", text: summarize(d) }], details: d };
			} catch (e) {
				const failed = e instanceof Error && "transfer" in e ? (e.transfer as TransferDetails) : undefined;
				const result = errorResult(`Transfer failed: ${e instanceof Error ? e.message : String(e)}`);
				return failed ? { ...result, details: failed } : result;
			}
		},
		renderCall(args: { direction: string; host: string; localPath: string; remotePath: string }) {
			const title = args.direction === "upload" ? "SSH upload" : "SSH download";
			const target = args.direction === "upload" ? args.localPath : args.remotePath;
			return n("row", { gap: "sm", align: "center" }, [
				txt([{ t: `${title} `, s: "toolTitle strong" }, { t: target }]),
				n("badge", { text: args.host, tone: "accent" }),
			]);
		},
		renderResult(result: { details?: TransferDetails | { error: string } }) {
			const d = result.details;
			if (!d || !("hostId" in d)) return undefined;
			const more = d.files - d.items.length;
			const meta = [d.hostId, `${d.filesDone}/${d.files} files`, humanBytes(d.bytes), ...(more > 0 ? [`+${more} more`] : [])];
			return n("col", { gap: "sm" }, [
				txt([{ t: meta.join(" · "), s: "muted" }]),
				n("checklist", {
					phases: [
						{
							id: "files",
							title: `${d.direction} ${d.hostId}`,
							items: d.items.map((it, i) => ({ id: String(i), text: it.path, status: it.status })),
						},
					],
				}),
			]);
		},
	});
}
