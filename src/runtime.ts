import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ConnectionPool, type Prompter } from "./core/connections";
import { type HostSpec, listConfigHosts, resolveHost } from "./core/hosts";
import { TransferTracker } from "./core/progress";
import { defaultRulesPath } from "./core/settings";
import { openHostKey } from "./ui/hostkey";
import { openSecret } from "./ui/secret";
import { syncProgressWidget } from "./ui/widget";

const STATUS_KEY = "pi-ssh";

/** Process-wide state shared by tools and commands. No I/O happens until first use. */
export interface Runtime {
	pool: ConnectionPool;
	/** Host ids with an "Always allow on this Host" Approval; cleared on session shutdown. */
	grants: Set<string>;
	tracker: TransferTracker;
	rulesPath: string;
	knownHostsPath: string;
	sshConfigPath: string;
	/** Aliases from ~/.ssh/config, re-read on every call. */
	configHosts(): string[];
	resolve(input: string): HostSpec;
	prompter(ctx: ExtensionContext): Prompter;
	/** Attach UI surfaces (status line, progress widget) to the context of the current tool or command call. */
	bind(ctx: ExtensionContext): void;
	/** Close Connections, drop Host Grants, clear UI surfaces. */
	dispose(): void;
}

export function createRuntime(): Runtime {
	const home = os.homedir();
	const sshDir = path.join(home, ".ssh");
	const configPath = path.join(sshDir, "config");
	const knownHostsPath = path.join(sshDir, "known_hosts");
	const defaults = { user: os.userInfo().username, home };

	const readConfig = (): string => {
		try {
			return fs.readFileSync(configPath, "utf8");
		} catch (e) {
			if (e instanceof Error && "code" in e && e.code === "ENOENT") return "";
			throw e;
		}
	};
	const resolve = (input: string) => resolveHost(input, readConfig(), defaults);

	const pool = new ConnectionPool({
		knownHostsPath,
		agentPath: process.env.SSH_AUTH_SOCK ?? (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined),
		resolveHost: resolve,
	});
	const tracker = new TransferTracker();
	const grants = new Set<string>();

	let boundCtx: ExtensionContext | undefined;
	let stopWidget: (() => void) | undefined;
	const updateStatus = () => {
		const count = pool.list().length;
		boundCtx?.ui.setStatus(STATUS_KEY, count ? `ssh: ${count} connected` : undefined);
	};
	pool.onChange(updateStatus);

	return {
		pool,
		grants,
		tracker,
		rulesPath: defaultRulesPath(),
		knownHostsPath,
		sshConfigPath: configPath,
		configHosts: () => listConfigHosts(readConfig()),
		resolve,
		prompter: ctx => ({
			confirmHostKey: info => (ctx.hasUI ? openHostKey(ctx, info) : Promise.resolve(false)),
			askSecret: title => (ctx.hasUI ? openSecret(ctx, title) : Promise.resolve(undefined)),
		}),
		bind(ctx) {
			if (boundCtx === ctx) return;
			stopWidget?.();
			boundCtx = ctx;
			stopWidget = syncProgressWidget(ctx, tracker);
			updateStatus();
		},
		dispose() {
			pool.closeAll();
			grants.clear();
			stopWidget?.();
			stopWidget = undefined;
			boundCtx?.ui.setStatus(STATUS_KEY, undefined);
			boundCtx = undefined;
		},
	};
}
