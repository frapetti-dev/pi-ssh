/**
 * Connection Manager: a persistent fullscreen screen (Hosts · Transfers · Security). Every interaction
 * (forms, confirms, live Transfers) happens inside it; only Approval, host-key and secret dialogs open
 * over it, and `registerPane` hands focus back when they close.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeNode, NativeScreen, NativeUiEvent, OverlayHandle } from "@oh-my-pi/pi-tui";
import type { HostSpec } from "../core/hosts";
import type { KnownHostEntry } from "../core/known-hosts";
import { exitLabel, humanBytes } from "../core/output";
import type { ExecDetails } from "../core/output";
import type { TransferState } from "../core/progress";
import type { RenderHost } from "./dialog";
import { registerPane } from "./focus";
import { Form, type FormResult, textField } from "./form";
import { LineInput } from "./line-input";
import { bar, button, fit, isClose, isKey, leafKey, Memo, n, txt } from "./nodes";
import type { PaneHost, PaneModel, PlannedTransfer, RulesView } from "./pane-model";
import { transferArrow } from "./widget";

export interface PaneOptions {
	preselect?: string;
	autoConnect?: boolean;
}

/** The Connection Manager component; `attach` receives the overlay handle used to regain focus. */
export interface Pane extends Component {
	dispose(): void;
	attach(h: OverlayHandle): void;
}

type Tab = "hosts" | "transfers" | "security";
type Purpose = "run" | "upload" | "download" | "new-host";
type Mode =
	| { kind: "list" }
	| { kind: "form"; purpose: Purpose; hostId?: string; form: Form }
	| { kind: "confirm"; text: string; yes: () => void; no?: () => void };

interface ActionDef {
	act: string;
	label: string;
	key: string;
}

interface Message {
	text: string;
	tone: "info" | "error";
}

interface RunningEntry {
	controller: AbortController;
	command: string;
	partial?: ExecDetails;
}

const TAB_ORDER: Tab[] = ["hosts", "transfers", "security"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const target = (h: HostSpec) => `${h.user}@${h.hostName}:${h.port}${h.proxyJump ? ` via ${h.proxyJump}` : ""}`;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const keyLabel = (k: string) => (k === "escape" ? "esc" : k);
const seconds = (ms: number) => (ms / 1000).toFixed(1);

function entryNote(e: KnownHostEntry): string {
	return `${e.type}  ${e.fingerprint}${e.hashed ? " (hashed)" : ""}${e.revoked ? " (revoked)" : ""}${!e.removable && !e.revoked ? " (pattern, not removable)" : ""}`;
}

export function buildPane(
	tui: RenderHost,
	done: () => void,
	model: PaneModel,
	opts: PaneOptions,
): Pane {
	let tab: Tab = "hosts";
	let selected = opts.preselect ?? "";
	let selectedGrant = "";
	const filter = new LineInput();
	let filtering = false;
	let mode: Mode = { kind: "list" };
	const running = new Map<string, RunningEntry>();
	const keys = new Map<string, KnownHostEntry[] | "loading">();
	let rules: RulesView | undefined;
	let message: Message | undefined;
	let version = 0;
	let finished = false;
	let unregister: (() => void) | undefined;

	let hostsCache: { version: number; list: PaneHost[] } | undefined;
	const allHosts = (): PaneHost[] => {
		if (hostsCache?.version !== version) hostsCache = { version, list: model.hosts() };
		return hostsCache.list;
	};
	const visible = (): PaneHost[] => {
		const q = filter.value.trim().toLowerCase();
		if (!q) return allHosts();
		return allHosts().filter(h => [h.id, h.spec?.hostName, h.spec?.user].some(s => s?.toLowerCase().includes(q)));
	};
	const current = (): PaneHost | undefined => allHosts().find(h => h.id === selected);

	const loadKeys = (): void => {
		const h = current();
		if (!h?.spec || keys.has(h.id)) return;
		const id = h.id;
		keys.set(id, "loading");
		model.knownHostEntries(id).then(
			list => keys.set(id, list),
			() => keys.set(id, []),
		).finally(() => {
			if (!finished) bump();
		});
	};

	/** Repair selections after any state change, then request a render. */
	const bump = (): void => {
		version++;
		const list = visible();
		if (!list.some(h => h.id === selected)) selected = list[0]?.id ?? "";
		const grants = model.grants();
		if (!grants.includes(selectedGrant)) selectedGrant = grants[0] ?? "";
		loadKeys();
		tui.requestRender();
	};

	const task = (p: Promise<string | undefined>): void => {
		p.then(
			text => {
				if (text !== undefined) message = { text, tone: "info" };
			},
			e => {
				message = { text: errorText(e), tone: "error" };
			},
		).finally(() => {
			if (!finished) bump();
		});
	};

	const loadRules = (): void => {
		rules = undefined;
		task(
			model.rules().then(r => {
				rules = r;
				return undefined;
			}),
		);
	};

	const teardown = (): void => {
		if (finished) return;
		finished = true;
		unsub();
		unregister?.();
		for (const r of running.values()) r.controller.abort();
	};
	const finish = (): void => {
		if (finished) return;
		teardown();
		done();
	};

	const unsub = model.subscribe(() => {
		if (!finished) bump();
	});

	const setTab = (next: Tab): void => {
		if (mode.kind !== "list") return;
		tab = next;
		if (next === "security") loadRules();
	};

	const openForm = (purpose: Purpose, form: Form, hostId?: string): void => {
		mode = { kind: "form", purpose, hostId, form };
	};

	const activeCount = (): number => model.transfers().filter(t => t.state === "running").length;

	// ------------------------------------------------------------------ actions

	const actions = (): ActionDef[] => {
		const close: ActionDef = { act: "close", label: "Close", key: "escape" };
		if (mode.kind === "confirm") {
			return [
				{ act: "yes", label: "Yes", key: "y" },
				{ act: "no", label: "No", key: "n" },
			];
		}
		if (mode.kind === "form") {
			const label = mode.purpose === "run" ? "Run" : mode.purpose === "new-host" ? "Add" : mode.purpose === "upload" ? "Upload" : "Download";
			return [
				{ act: "form-submit", label, key: "enter" },
				{ act: "form-cancel", label: "Cancel", key: "escape" },
			];
		}
		const out: ActionDef[] = [];
		if (tab === "hosts") {
			const h = current();
			const spec = h?.spec;
			const conn = h ? model.connection(h.id) : undefined;
			if (h && spec) {
				if (!conn && !model.connecting(h.id)) out.push({ act: "connect", label: "Connect", key: "c" });
				if (conn) out.push({ act: "disconnect", label: "Disconnect", key: "d" });
				if (running.has(h.id)) out.push({ act: "cancel-run", label: "Cancel run", key: "k" });
				else out.push({ act: "run", label: "Run…", key: "r" });
				out.push({ act: "upload", label: "Upload…", key: "u" }, { act: "download", label: "Download…", key: "g" });
				if (model.canShell()) out.push({ act: "shell", label: "Shell in split", key: "s" });
				const cached = keys.get(h.id);
				if (Array.isArray(cached) && cached.some(e => e.removable)) out.push({ act: "forget", label: "Forget host key", key: "f" });
				if (model.grants().includes(h.id)) out.push({ act: "revoke", label: "Revoke grant", key: "x" });
			}
			out.push({ act: "new-host", label: "New host…", key: "n" }, { act: "filter", label: "Filter", key: "/" });
		} else if (tab === "security") {
			if (selectedGrant) out.push({ act: "revoke-grant", label: "Revoke grant", key: "x" });
			if (model.canOpenRules()) out.push({ act: "open-rules", label: "Open rules file", key: "o" });
			out.push({ act: "reload-rules", label: "Reload rules", key: "l" });
		}
		out.push(close);
		return out;
	};

	const submitRun = (id: string, form: Form): void => {
		const command = form.text("command");
		if (!command) {
			form.error = "Command is required";
			return;
		}
		mode = { kind: "list" };
		const controller = new AbortController();
		const entry: RunningEntry = { controller, command };
		running.set(id, entry);
		model
			.run(id, command, {
				signal: controller.signal,
				onPartial: d => {
					entry.partial = d;
					if (!finished) bump();
				},
			})
			.then(
				d => {
					message = controller.signal.aborted
						? { text: "Run cancelled", tone: "info" }
						: { text: `${id}: exit ${exitLabel(d)} · ${seconds(d.durationMs)}s`, tone: "info" };
				},
				e => {
					message = controller.signal.aborted ? { text: "Run cancelled", tone: "info" } : { text: errorText(e), tone: "error" };
				},
			)
			.finally(() => {
				if (running.get(id) === entry) running.delete(id);
				if (!finished) bump();
			});
	};

	const startTransfer = (id: string, planned: PlannedTransfer): void => {
		message = { text: "Transferring…", tone: "info" };
		task(model.executeTransfer(id, planned));
	};

	const submitTransfer = (id: string, direction: "upload" | "download", form: Form): void => {
		const local = form.text("local");
		const remote = form.text("remote");
		if (!local) {
			form.error = "Local path is required";
			return;
		}
		if (!remote) {
			form.error = "Remote path is required";
			return;
		}
		mode = { kind: "list" };
		message = { text: "Planning transfer…", tone: "info" };
		model.planTransfer(id, direction, local, remote).then(
			planned => {
				if (planned.existing === 0) return startTransfer(id, planned);
				// The confirm lives on the Hosts tab with its Host selected.
				tab = "hosts";
				selected = id;
				filter.value = "";
				filter.cursor = 0;
				filtering = false;
				message = undefined;
				mode = {
					kind: "confirm",
					text: `Overwrite ${planned.existing} existing ${direction === "upload" ? "remote" : "local"} file(s)?`,
					yes: () => startTransfer(id, planned),
					no: () => {
						message = { text: "Transfer cancelled", tone: "info" };
					},
				};
				if (!finished) bump();
			},
			e => {
				message = { text: errorText(e), tone: "error" };
				if (!finished) bump();
			},
		);
	};

	const submitNewHost = (form: Form): void => {
		const save = form.on("save");
		model
			.addHost(
				{
					alias: form.text("alias"),
					hostName: form.text("hostName"),
					user: form.text("user"),
					port: form.text("port"),
					identityFile: form.text("identityFile"),
					proxyJump: form.text("proxyJump"),
				},
				save,
			)
			.then(
				id => {
					mode = { kind: "list" };
					selected = id;
					filter.value = "";
					filter.cursor = 0;
					filtering = false;
					message = { text: save ? `Saved ${id} to ~/.ssh/config` : `Added ad-hoc host ${id}`, tone: "info" };
				},
				e => {
					form.error = errorText(e);
				},
			)
			.finally(() => {
				if (!finished) bump();
			});
	};

	const applyFormResult = (result: FormResult): void => {
		if (mode.kind !== "form") return;
		if (result === "cancel") {
			mode = { kind: "list" };
			return;
		}
		if (result !== "submit") return;
		const { purpose, hostId, form } = mode;
		if (purpose === "new-host") return submitNewHost(form);
		if (!hostId) return;
		if (purpose === "run") return submitRun(hostId, form);
		submitTransfer(hostId, purpose, form);
	};

	const confirmAnswer = (yes: boolean): void => {
		if (mode.kind !== "confirm") return;
		const { yes: onYes, no: onNo } = mode;
		mode = { kind: "list" };
		if (yes) onYes();
		else onNo?.();
	};

	const act = (name: string): void => {
		const h = current();
		const id = h?.id ?? "";
		switch (name) {
			case "close":
				return finish();
			case "connect":
				if (!id) return;
				return task(
					model.connect(id).then(() => {
						keys.delete(id);
						return `Connected to ${id}`;
					}),
				);
			case "disconnect":
				return model.disconnect(id);
			case "revoke":
				return model.revokeGrant(id);
			case "revoke-grant":
				return model.revokeGrant(selectedGrant);
			case "run":
				return openForm("run", new Form(`Run on ${id}`, [textField("command", "Command", "uname -a")], "Run"), id);
			case "cancel-run":
				return running.get(id)?.controller.abort();
			case "upload":
			case "download": {
				const up = name === "upload";
				return openForm(
					name,
					new Form(
						up ? `Upload to ${id}` : `Download from ${id}`,
						[textField("local", "Local path", up ? "./dist" : "./downloads"), textField("remote", "Remote path", "~/")],
						up ? "Upload" : "Download",
					),
					id,
				);
			}
			case "shell":
				return task(model.openShell(id).then(() => undefined));
			case "forget": {
				const cached = keys.get(id);
				const count = Array.isArray(cached) ? cached.filter(e => e.removable).length : 0;
				mode = {
					kind: "confirm",
					text: `Remove ${count} stored key(s) for ${id} from ~/.ssh/known_hosts? The next connect asks to trust the key again.`,
					yes: () =>
						task(
							model.forgetHostKey(id).then(removed => {
								keys.delete(id);
								return `Removed ${removed} key(s) for ${id}`;
							}),
						),
				};
				return;
			}
			case "new-host":
				return openForm(
					"new-host",
					new Form(
						"New host",
						[
							textField("alias", "Alias"),
							textField("hostName", "HostName"),
							textField("user", "User"),
							textField("port", "Port", "22"),
							textField("identityFile", "IdentityFile"),
							textField("proxyJump", "ProxyJump"),
							{ kind: "toggle", id: "save", label: "Save to ~/.ssh/config", on: true },
						],
						"Add",
					),
				);
			case "filter":
				filtering = true;
				return;
			case "open-rules":
				return task(model.openRulesFile().then(() => undefined));
			case "reload-rules":
				return loadRules();
		}
	};

	const move = (delta: number): void => {
		if (tab === "hosts") {
			const list = visible();
			const i = list.findIndex(h => h.id === selected);
			selected = list[clamp(i + delta, 0, list.length - 1)]?.id ?? selected;
		} else if (tab === "security") {
			const grants = model.grants();
			const i = grants.indexOf(selectedGrant);
			selectedGrant = grants[clamp(i + delta, 0, grants.length - 1)] ?? selectedGrant;
		}
	};

	// ------------------------------------------------------------------- events

	const onEvent = (e: NativeUiEvent): void => {
		if (e.type === "select" || e.type === "activate") {
			const leaf = leafKey(e.key);
			if (leaf === "tabs") setTab(e.item as Tab);
			else if (mode.kind === "list" && leaf === "items") {
				selected = e.item;
				if (e.type === "activate" && actions().some(a => a.act === "connect")) act("connect");
			} else if (mode.kind === "list" && leaf === "grants") selectedGrant = e.item;
		} else if (e.type === "action") {
			if (mode.kind === "form") {
				if (e.act === "close") mode = { kind: "list" };
				else applyFormResult(mode.form.handleAction(e.act));
			} else if (mode.kind === "confirm") {
				if (e.act === "yes" || e.act === "no") confirmAnswer(e.act === "yes");
			} else if (actions().some(a => a.act === e.act)) act(e.act);
		}
		bump();
	};

	const handleKey = (data: string): void => {
		if (mode.kind === "confirm") {
			if (data === "y") confirmAnswer(true);
			else if (data === "n" || isKey(data, "escape")) confirmAnswer(false);
			return;
		}
		if (mode.kind === "form") {
			applyFormResult(mode.form.handleInput(data));
			return;
		}
		if (filtering) {
			if (isKey(data, "enter")) filtering = false;
			else if (isKey(data, "escape")) {
				filter.value = "";
				filter.cursor = 0;
				filtering = false;
			} else if (isKey(data, "up")) move(-1);
			else if (isKey(data, "down")) move(1);
			else filter.handleInput(data);
			return;
		}
		const digit = ["1", "2", "3"].indexOf(data);
		if (digit >= 0) return setTab(TAB_ORDER[digit]!);
		if (isKey(data, "up")) return move(-1);
		if (isKey(data, "down")) return move(1);
		const available = actions();
		if (isKey(data, "enter") && tab === "hosts" && available.some(a => a.act === "connect")) return act("connect");
		if (isClose(data) && !available.some(a => a.key === data && a.key !== "escape")) return finish();
		const hit = available.find(a => (a.key === "escape" ? isKey(data, "escape") : a.key === data));
		if (hit) act(hit.act);
	};

	// ----------------------------------------------------------------- describe

	const hostsTab = (): NativeNode => {
		const sel = current();
		const grants = new Set(model.grants());
		const rows = visible().map(h => {
			const conn = model.connection(h.id);
			const connecting = model.connecting(h.id);
			const detail = (h.error ?? (h.spec ? target(h.spec) : "")) + (grants.has(h.id) ? " · always-allow" : "");
			return n(
				"item",
				{
					label: h.id,
					detail,
					icon: h.error ? "warn" : "server",
					tone: h.error ? "error" : connecting ? "warning" : conn ? "success" : "muted",
				},
				undefined,
				h.id,
			);
		});
		const left = n(
			"col",
			{ gap: "sm", min: { w: "28ch" } },
			[
				...(filtering || filter.value ? [filter.node({ key: "filter", focused: filtering, placeholder: "filter hosts" })] : []),
				n("list", { selected, empty: "No hosts" }, rows, "items"),
			],
			"left",
		);

		const newHost = mode.kind === "form" && mode.purpose === "new-host";
		const head = newHost ? "New host" : (sel?.id ?? "(none)");
		const kids: NativeNode[] = [];
		if (sel && !newHost) {
			if (sel.error) kids.push(txt([{ t: sel.error, s: "error" }]));
			const conn = model.connection(sel.id);
			const connecting = model.connecting(sel.id);
			if (sel.spec) {
				kids.push(
					n("kv", {
						items: [
							{ k: "HostName", v: sel.spec.hostName },
							{ k: "User", v: sel.spec.user },
							{ k: "Port", v: String(sel.spec.port) },
							{ k: "ProxyJump", v: sel.spec.proxyJump ?? "-" },
							{ k: "IdentityFile", v: sel.spec.identityFiles.join(", ") || "-" },
							{ k: "Source", v: sel.adhoc ? "ad hoc" : "~/.ssh/config" },
							{ k: "State", v: conn ? "connected" : connecting ? "connecting" : "disconnected" },
						],
					}),
				);
				if (connecting) kids.push(n("spinner", { label: "Connecting…" }, undefined, "connecting"));
				if (conn) kids.push(n("elapsed", { age: Date.now() - conn.connectedAt, format: "short" }, undefined, "age"));
				if (grants.has(sel.id)) kids.push(n("badge", { text: "always-allow", tone: "warning" }, undefined, "grant"));

				const stored = keys.get(sel.id);
				const keyRows: NativeNode[] = [];
				if (conn) {
					keyRows.push(
						n("kv", {
							items: [
								{ k: "Live type", v: conn.hostKey.type },
								{ k: "Live fingerprint", v: [{ t: conn.hostKey.fingerprint, s: "mono" }] },
							],
						}),
					);
				}
				if (stored === "loading" || stored === undefined) keyRows.push(n("spinner", { label: "Loading stored keys…" }, undefined, "keys-loading"));
				else if (stored.length === 0) keyRows.push(txt([{ t: "No stored key", s: "muted" }]));
				else for (const entry of stored) keyRows.push(txt([{ t: entryNote(entry), s: "mono" }]));
				kids.push(n("section", { head: "Host key" }, keyRows, "hostkey"));
			}
		}
		if (mode.kind === "form") kids.push(mode.form.describe());
		else if (mode.kind === "confirm") kids.push(txt([{ t: mode.text, s: "warning" }]));

		if (sel?.spec && !newHost) {
			const live = running.get(sel.id);
			const last = live?.partial ?? model.lastRun(sel.id);
			const runKids: NativeNode[] = [];
			if (live) runKids.push(n("spinner", { label: `Running ${live.command}` }, undefined, "running"));
			if (last) {
				runKids.push(
					n("kv", {
						items: [
							{ k: "Command", v: [{ t: last.command, s: "mono" }] },
							{ k: "Exit", v: live ? "running" : exitLabel(last) },
							{ k: "Took", v: `${seconds(last.durationMs)}s` },
							{ k: "Approved by", v: last.approvedBy },
						],
					}),
					n("ansi", { text: last.stdout, max: { h: "20lines" } }, undefined, "stdout"),
				);
				if (last.stderr) {
					runKids.push(n("rule", { label: "stderr" }), n("ansi", { text: last.stderr, max: { h: "20lines" } }, undefined, "stderr"));
				}
			}
			if (runKids.length) kids.push(n("section", { head: "Last run" }, runKids, "lastrun"));
		}
		if (!sel && !newHost && mode.kind === "list") kids.push(txt([{ t: "No hosts. Press n to add one.", s: "muted" }]));

		return n("row", { gap: "lg", align: "stretch" }, [left, n("card", { head, grow: 1 }, kids, "detail")], "hosts");
	};

	const transferRow = (t: TransferState): NativeNode => {
		const head = [`${transferArrow(t)} ${t.label}`, t.hostId].map(s => txt(s));
		const tail =
			t.state === "running"
				? [
						n("progress", { value: t.totalBytes > 0 ? t.doneBytes / t.totalBytes : null }),
						n("rate", { value: t.bytesPerSec, unit: "B/s" }),
						txt(`${t.filesDone}/${t.files}`),
						n("elapsed", { age: Date.now() - t.startedAt, format: "short" }),
					]
				: t.state === "done"
					? [
							n("badge", { text: "done", tone: "success" }),
							txt(humanBytes(t.totalBytes)),
							txt(`${seconds((t.finishedAt ?? t.startedAt) - t.startedAt)}s`),
						]
					: [n("badge", { text: "error", tone: "error" }), txt([{ t: t.error ?? "failed", s: "error" }])];
		return n(
			"row",
			{ gap: "sm", align: "center" },
			[...(t.state === "running" ? [n("spinner", { style: "orbit" })] : []), ...head, ...tail],
			`t${t.id}`,
		);
	};

	const transfersTab = (): NativeNode => {
		const list = model.transfers();
		if (!list.length) return txt([{ t: "No Transfers in this omp session.", s: "muted" }]);
		return n("list", {}, list.map(transferRow), "transfers");
	};

	const securityTab = (): NativeNode => {
		const grants = model.grants();
		const grantBody: NativeNode[] = grants.length
			? [
					n(
						"list",
						{ selected: selectedGrant },
						grants.map(g => n("item", { label: g, icon: "key", tone: "warning" }, undefined, g)),
						"grants",
					),
				]
			: [txt([{ t: "No Host Grants. Choosing 'Always allow on this Host' in an Approval adds one.", s: "muted" }])];
		const ruleBody: NativeNode[] = [];
		if (!rules) ruleBody.push(n("spinner", { label: "Loading rules…" }, undefined, "rules-loading"));
		else {
			ruleBody.push(n("kv", { items: [{ k: "File", v: rules.path + (rules.exists ? "" : " (not created)") }] }));
			if (rules.warning) ruleBody.push(txt([{ t: rules.warning, s: "warning" }]));
			for (const [key, head, rows] of [
				["allow", "Allow", rules.allow],
				["deny", "Deny", rules.deny],
			] as const) {
				ruleBody.push(
					n(
						"table",
						{
							cols: [{ id: "rule", head, grow: 1 }, { id: "source", head: "Source" }],
							rows: rows.map(r => ({ id: r.rule, cells: { rule: r.rule, source: r.builtin ? "built-in" : "pi-ssh.json" } })),
						},
						undefined,
						key,
					),
				);
			}
		}
		return n(
			"col",
			{ gap: "md" },
			[n("section", { head: "Host Grants" }, grantBody, "grants-section"), n("section", { head: "Rules" }, ruleBody, "rules")],
			"security",
		);
	};

	const bodyMemo = new Memo();
	const body: Component = {
		describe(_cx: DescribeContext): NativeNode {
			return bodyMemo.get([version], () => {
				const active = activeCount();
				const tabs = n(
					"tabs",
					{
						items: [
							{ id: "hosts", label: "Hosts" },
							{ id: "transfers", label: `Transfers${active ? ` (${active})` : ""}` },
							{ id: "security", label: "Security" },
						],
						active: tab,
					},
					undefined,
					"tabs",
				);
				const content = tab === "hosts" ? hostsTab() : tab === "transfers" ? transfersTab() : securityTab();
				return n("col", { gap: "md" }, [tabs, content], "body");
			});
		},
		handleNativeEvent: onEvent,
		render(): readonly string[] {
			return [];
		},
		invalidate(): void {},
	};

	const hints = (): string =>
		mode.kind === "form"
			? "tab next field · enter submit · esc cancel"
			: mode.kind === "confirm"
				? "y yes · n no"
				: "↑↓ select · 1-3 tabs · / filter · esc close";

	const rootMemo = new Memo();
	const root: Pane = {
		describeScreen(_cx: DescribeContext): NativeScreen {
			return { role: "pi-ssh.screen", main: [body], dock: [root] };
		},
		describe(_cx: DescribeContext): NativeNode {
			return rootMemo.get([version], () =>
				n("col", { gap: "sm" }, [
					n("status", {}, [
						n("seg", { spans: [{ t: `${model.hosts().filter(h => model.connection(h.id)).length} connected · ${activeCount()} transferring` }], side: "left" }),
						...(message ? [n("seg", { spans: [{ t: message.text, s: message.tone === "error" ? "error" : undefined }], side: "left" })] : []),
						n("seg", { spans: [{ t: hints(), s: "muted" }], side: "right" }),
					]),
					bar(actions().map(a => button(a.label, a.act, a.key))),
				]),
			);
		},
		handleNativeEvent: onEvent,
		handleInput(data: string): void {
			if (finished) return;
			message = undefined;
			handleKey(data);
			if (!finished) bump();
		},
		render(width: number): readonly string[] {
			const connected = model.hosts().filter(h => model.connection(h.id)).length;
			const tabLine = TAB_ORDER.map(t => {
				const label = t[0]!.toUpperCase() + t.slice(1);
				return t === tab ? `[${label}]` : label;
			}).join(" ");
			const lines = [`SSH  ${tabLine}  ·  ${connected} connected`];
			if (tab === "hosts") {
				if (filtering || filter.value) lines.push(`/ ${filter.value}`);
				const list = visible();
				for (const h of list) {
					const state = model.connection(h.id) ? "*" : model.connecting(h.id) ? "~" : " ";
					lines.push(`${h.id === selected ? ">" : " "} ${state} ${h.id} - ${h.error ?? (h.spec ? target(h.spec) : "")}`);
				}
				if (!list.length) lines.push("No hosts. Press n to add one.");
				if (mode.kind === "form") lines.push(mode.form.title, ...mode.form.ansi());
				else if (mode.kind === "confirm") lines.push(mode.text);
				const live = running.get(selected);
				const last = live?.partial ?? model.lastRun(selected);
				if (last) {
					lines.push(`exit ${live ? "running" : exitLabel(last)} · ${seconds(last.durationMs)}s · ${last.command}`);
					lines.push(...last.stdout.split("\n").filter(Boolean).slice(-5));
				}
			} else if (tab === "transfers") {
				const list = model.transfers();
				if (!list.length) lines.push("No Transfers in this omp session.");
				for (const t of list) {
					if (t.state === "running") {
						const pct = t.totalBytes > 0 ? Math.floor((t.doneBytes / t.totalBytes) * 100) : 0;
						lines.push(`${transferArrow(t)} ${t.label} ${t.hostId} ${pct}% ${humanBytes(Math.round(t.bytesPerSec))}/s ${t.filesDone}/${t.files}`);
					} else if (t.state === "done") lines.push(`${transferArrow(t)} ${t.label} ${t.hostId} done ${humanBytes(t.totalBytes)}`);
					else lines.push(`${transferArrow(t)} ${t.label} ${t.hostId} error: ${t.error ?? "failed"}`);
				}
			} else {
				const grants = model.grants();
				if (!grants.length) lines.push("No Host Grants.");
				for (const g of grants) lines.push(`${g === selectedGrant ? ">" : " "} ${g} (always-allow)`);
				if (rules) {
					lines.push(`Rules: ${rules.allow.length} allow, ${rules.deny.length} deny · ${rules.path}`);
					if (rules.warning) lines.push(rules.warning);
				} else lines.push("Loading rules…");
			}
			if (message) lines.push(message.text);
			lines.push(actions().map(a => `[${keyLabel(a.key)}] ${a.label}`).join("  "));
			return lines.map(l => fit(l, width));
		},
		invalidate(): void {},
		dispose(): void {
			teardown();
		},
		attach(h: OverlayHandle): void {
			unregister?.();
			unregister = registerPane(() => {
				h.setHidden(true);
				h.setHidden(false);
				bump();
			});
		},
	};

	if (opts.preselect) selected = opts.preselect;
	bump();
	if (opts.autoConnect && opts.preselect && actions().some(a => a.act === "connect")) act("connect");
	return root;
}

export async function openPane(ctx: ExtensionContext, model: PaneModel, opts: PaneOptions): Promise<void> {
	let pane: Pane | undefined;
	await ctx.ui.custom<void>(
		(tui, _theme, _kb, done) => {
			pane = buildPane(tui, done, model, opts);
			return pane;
		},
		{ overlay: true, overlayOptions: { fullscreen: true }, onHandle: h => pane?.attach(h) },
	);
}
