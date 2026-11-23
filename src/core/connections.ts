import * as fs from "node:fs/promises";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Client, type ConnectConfig, type SFTPWrapper, utils } from "ssh2";
import type { HostSpec } from "./hosts";
import { appendKnownHost, checkHostKey, hostField, keyInfo } from "./known-hosts";

export interface Prompter {
	confirmHostKey(i: { host: HostSpec; type: string; fingerprint: string; knownTypes: string[] }): Promise<boolean>;
	/** Masked prompt. Returns undefined when the user cancels or no UI is available. */
	askSecret(title: string): Promise<string | undefined>;
}

/** Passed to `sudo -p`; seeing it on stderr means sudo is waiting for the password on stdin. */
export const SUDO_PROMPT = "[pi-ssh:sudo-password]";

export interface ExecOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	onData?(stream: "stdout" | "stderr", chunk: string): void;
	/** Answers SUDO_PROMPT on stderr. Resolve undefined to cancel (signal SUDO_CANCELLED); a second prompt means the password was wrong (signal SUDO_DENIED). */
	sudoPassword?(): Promise<string | undefined>;
}

export interface ExecResult {
	code: number | null;
	signal?: string;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface Connection {
	spec: HostSpec;
	client: Client;
	connectedAt: number;
	/** Host key verified during the handshake. */
	hostKey: { type: string; fingerprint: string };
	sftp(): Promise<SFTPWrapper>;
	exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
	close(): void;
}

export interface PoolOptions {
	knownHostsPath: string;
	agentPath: string | undefined;
	/** Resolves a ProxyJump value (alias or user@host[:port]) to a Host. */
	resolveHost(input: string): HostSpec;
	algorithms?: ConnectConfig["algorithms"];
	readyTimeoutMs?: number;
}

/** Per-stream retention cap; a runaway command is killed instead of exhausting memory. */
const MAX_STREAM_CHARS = 32 * 1024 * 1024;
const PASSWORD_TRIES = 3;

function createExec(client: Client) {
	return (cmd: string, opts: ExecOptions): Promise<ExecResult> => {
		const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
		const start = Date.now();
		client.exec(cmd, (err, stream) => {
			if (err) {
				reject(err);
				return;
			}
			let stdout = "";
			let stderr = "";
			let code: number | null = null;
			let exitSignal: string | undefined;
			let settled = false;
			let sudoPrompts = 0;
			let scanFrom = 0;
			const finish = (extra: { timedOut?: boolean; signal?: string }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
				resolve({
					code: extra.timedOut || extra.signal ? null : code,
					signal: extra.signal ?? exitSignal,
					timedOut: extra.timedOut ?? false,
					stdout,
					stderr: opts.sudoPassword ? stderr.replaceAll(SUDO_PROMPT, "") : stderr,
					durationMs: Date.now() - start,
				});
			};
			const kill = (extra: { timedOut?: boolean; signal?: string }) => {
				if (settled) return;
				try {
					stream.signal("KILL");
					stream.close();
				} catch {
					// channel already gone
				}
				finish(extra);
			};
			const onAbort = () => kill({ signal: "ABORTED" });
			// shortcut: timeout keeps ticking during the password dialog; pause it if users hit timeouts while typing.
			const timer = setTimeout(() => kill({ timedOut: true }), opts.timeoutMs);
			const answerSudo = async () => {
				if (++sudoPrompts > 1) return kill({ signal: "SUDO_DENIED" });
				const password = await opts.sudoPassword!();
				if (settled) return;
				if (password === undefined) return kill({ signal: "SUDO_CANCELLED" });
				stream.write(`${password}\n`);
			};
			if (opts.signal?.aborted) {
				onAbort();
				return;
			}
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			const collect = (which: "stdout" | "stderr") => {
				const decoder = new StringDecoder("utf8");
				return (data: Buffer) => {
					if (settled) return;
					let chunk = decoder.write(data);
					if (which === "stdout") stdout += chunk;
					else {
						stderr += chunk;
						if (opts.sudoPassword) {
							let i: number;
							while ((i = stderr.indexOf(SUDO_PROMPT, scanFrom)) >= 0) {
								scanFrom = i + SUDO_PROMPT.length;
								void answerSudo().catch(() => kill({ signal: "SUDO_CANCELLED" }));
							}
							// keep the tail so a marker split across chunks is found once; scan stays linear
							scanFrom = Math.max(scanFrom, stderr.length - SUDO_PROMPT.length + 1);
							// shortcut: a marker split across chunks can flash in live partial output; the final result is clean. Upgrade if users see it.
							chunk = chunk.replaceAll(SUDO_PROMPT, "");
						}
					}
					opts.onData?.(which, chunk);
					if (stdout.length > MAX_STREAM_CHARS || stderr.length > MAX_STREAM_CHARS) {
						kill({ signal: "OUTPUT_LIMIT" });
					}
				};
			};
			stream.on("data", collect("stdout"));
			stream.stderr.on("data", collect("stderr"));
			stream.on("exit", (c: number | null, s?: string) => {
				code = c ?? null;
				exitSignal = s || undefined;
			});
			stream.on("close", () => finish({}));
		});
		return promise;
	};
}

export class ConnectionPool {
	private readonly conns = new Map<string, Connection>();
	private readonly pending = new Map<string, Promise<Connection>>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly opts: PoolOptions) {}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	list(): Connection[] {
		return [...this.conns.values()];
	}

	close(id: string): boolean {
		const conn = this.conns.get(id);
		conn?.close();
		return conn !== undefined;
	}

	closeAll(): void {
		for (const conn of this.conns.values()) conn.close();
	}

	get(spec: HostSpec, prompter: Prompter): Promise<Connection> {
		const live = this.conns.get(spec.id);
		if (live) return Promise.resolve(live);
		const inflight = this.pending.get(spec.id);
		if (inflight) return inflight;
		const p = this.connect(spec, prompter).finally(() => {
			this.pending.delete(spec.id);
			this.notify();
		});
		this.pending.set(spec.id, p);
		this.notify();
		return p;
	}

	/** Ids of Hosts with a Connection attempt in flight. */
	connecting(): string[] {
		return [...this.pending.keys()];
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}

	private async connect(spec: HostSpec, prompter: Prompter): Promise<Connection> {
		let sock: Duplex | undefined;
		let verifiedKey: { type: string; fingerprint: string } | undefined;
		let jump: Connection | undefined;
		if (spec.proxyJump) {
			jump = await this.get(this.opts.resolveHost(spec.proxyJump), prompter);
			const via = jump.client;
			const forwarded = Promise.withResolvers<Duplex>();
			via.forwardOut("127.0.0.1", 0, spec.hostName, spec.port, (err, stream) =>
				err ? forwarded.reject(err) : forwarded.resolve(stream),
			);
			sock = await forwarded.promise;
		}

		const client = new Client();
		let failure: string | undefined;
		const tried: string[] = [];
		let methodsLeft: string[] | null = null;

		const hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
			void (async () => {
				const field = hostField(spec.hostName, spec.port);
				const { fingerprint, type } = keyInfo(key);
				let text = "";
				try {
					text = await fs.readFile(this.opts.knownHostsPath, "utf8");
				} catch {
					// missing known_hosts is treated as empty
				}
				const { status, knownTypes } = checkHostKey(text, spec.hostName, spec.port, key);
				if (status === "match") {
					verifiedKey = { type, fingerprint };
					return verify(true);
				}
				if (status === "mismatch") {
					failure = `Host key for ${field} changed (fingerprint ${fingerprint}). Refusing to connect; fix ~/.ssh/known_hosts manually.`;
					return verify(false);
				}
				if (status === "revoked") {
					failure = `Host key for ${field} is revoked (fingerprint ${fingerprint}). Refusing to connect.`;
					return verify(false);
				}
				if (!(await prompter.confirmHostKey({ host: spec, type, fingerprint, knownTypes }))) {
					failure = "Host key not trusted by user.";
					return verify(false);
				}
				try {
					await appendKnownHost(this.opts.knownHostsPath, spec.hostName, spec.port, key);
				} catch (e) {
					failure = `Could not save host key: ${e instanceof Error ? e.message : String(e)}`;
					return verify(false);
				}
				verifiedKey = { type, fingerprint };
				verify(true);
			})();
		};

		const candidates = this.authCandidates(spec, prompter, tried, () => methodsLeft);
		const authHandler = (left: string[] | null, _partial: boolean, next: (a: unknown) => void): void => {
			methodsLeft = left;
			candidates.next().then(
				r => next(r.done ? false : r.value),
				() => next(false),
			);
		};

		const ready = Promise.withResolvers<void>();
		client.once("ready", ready.resolve);
		// Persistent: ssh2 can emit "error" again after the first (socket reset after an auth failure, keepalive
		// timeout once connected). With no listener that throws inside ssh2's callbacks as an unhandled rejection.
		// After the handshake, "error" is followed by "close", which cleans up; ready.reject is then a no-op.
		client.on("error", (err: Error & { level?: string }) => {
			if (failure) ready.reject(new Error(failure));
			else if (err.level === "client-authentication") {
				ready.reject(new Error(`Authentication failed for ${spec.id} (tried: ${tried.join(", ") || "none"})`));
			} else ready.reject(err);
		});
		client.once("close", () => ready.reject(new Error(failure ?? `Connection to ${spec.id} closed before it was ready`)));
		client.connect({
			host: spec.hostName,
			port: spec.port,
			username: spec.user,
			sock,
			hostVerifier,
			authHandler: authHandler as ConnectConfig["authHandler"],
			keepaliveInterval: 15000,
			readyTimeout: this.opts.readyTimeoutMs ?? 20000,
			algorithms: this.opts.algorithms,
		});
		await ready.promise;

		let sftpPromise: Promise<SFTPWrapper> | undefined;
		const conn: Connection = {
			spec,
			client,
			connectedAt: Date.now(),
			hostKey: verifiedKey ?? { type: "unknown", fingerprint: "unknown" },
			sftp() {
				if (!sftpPromise) {
					const { promise, resolve, reject } = Promise.withResolvers<SFTPWrapper>();
					client.sftp((err, s) => (err ? reject(err) : resolve(s)));
					promise.catch(() => {
						sftpPromise = undefined;
					});
					sftpPromise = promise;
				}
				return sftpPromise;
			},
			exec: createExec(client),
			close: () => client.end(),
		};
		this.conns.set(spec.id, conn);
		client.on("close", () => {
			if (this.conns.get(spec.id) === conn) this.conns.delete(spec.id);
			this.notify();
		});
		jump?.client.once("close", () => client.end());
		this.notify();
		return conn;
	}

	/** Auth attempts in order: agent, key files, keyboard-interactive, password. Secrets never leave this scope. */
	private async *authCandidates(
		spec: HostSpec,
		prompter: Prompter,
		tried: string[],
		left: () => string[] | null,
	): AsyncGenerator<Record<string, unknown>> {
		const username = spec.user;
		const offered = (m: string) => left()?.includes(m) ?? true;
		if (this.opts.agentPath) {
			tried.push("agent");
			yield { type: "agent", username, agent: this.opts.agentPath };
		}
		for (const file of spec.identityFiles) {
			if (!offered("publickey")) break;
			let buf: Buffer;
			try {
				buf = await fs.readFile(file);
			} catch {
				continue;
			}
			let key = utils.parseKey(buf);
			let passphrase: string | undefined;
			if (key instanceof Error && /passphrase/i.test(key.message)) {
				for (let attempt = 0; attempt < 3; attempt++) {
					passphrase = await prompter.askSecret(`Passphrase for ${file}`);
					if (passphrase === undefined) break;
					key = utils.parseKey(buf, passphrase);
					if (!(key instanceof Error)) break;
				}
			}
			if (key instanceof Error) continue;
			tried.push(`publickey:${file}`);
			yield { type: "publickey", username, key: Array.isArray(key) ? key[0] : key, passphrase };
		}
		if (offered("keyboard-interactive")) {
			tried.push("keyboard-interactive");
			yield {
				type: "keyboard-interactive",
				username,
				prompt: async (_name: string, _instr: string, _lang: string, prompts: { prompt: string }[], finish: (a: string[]) => void) => {
					const answers: string[] = [];
					for (const p of prompts) {
						const a = await prompter.askSecret(p.prompt);
						if (a === undefined) return finish([]);
						answers.push(a);
					}
					finish(answers);
				},
			};
		}
		if (offered("password")) {
			tried.push("password");
			for (let attempt = 0; attempt < PASSWORD_TRIES; attempt++) {
				const password = await prompter.askSecret(`Password for ${spec.user}@${spec.hostName}`);
				if (password === undefined) return;
				yield { type: "password", username, password };
			}
		}
	}
}
