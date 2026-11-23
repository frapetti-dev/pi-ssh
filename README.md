# pi-ssh

Safe SSH for [omp](https://github.com/can1357/oh-my-pi): connect to Hosts, run remote commands and transfer files, from the agent or from `/ssh-manager`.

[Features](#features) · [Install](#install) · [Usage](#usage) · [Configuration](#configuration) · [Development](#development)

## Features

- **Persistent Connections** over the pure-JS [`ssh2`](https://github.com/mscdex/ssh2) library, reused by every command and transfer until disconnected or the omp session ends.
- **Hosts from `~/.ssh/config`** (`Host`, `HostName`, `User`, `Port`, `IdentityFile`, single-level `ProxyJump`) plus ad-hoc `user@host[:port]`.
- **Command gate**: read-only allowlisted commands run immediately; everything else asks first. The gate is enforced in every omp approval mode, including `yolo`.
- **Host key trust on first use**: unknown keys show their fingerprint before being added to `~/.ssh/known_hosts`. A changed or revoked key is always refused.
- **Credentials**: ssh-agent, key files, and masked prompts for passphrases, passwords and keyboard-interactive. Secrets stay in memory for the handshake only.
- **File transfer** over SFTP with `scp -r` semantics and a progress widget.
- **Native Tern UI** with an ANSI fallback for Windows Terminal, tmux and `PI_TUI_NATIVE=0`.

## Install

Requires [Bun](https://bun.sh) and omp.

```sh
git clone <repo-url> pi-ssh
cd pi-ssh
bun install
omp plugin link .
```

Restart omp afterwards.

## Usage

### Agent tools

| Tool | Purpose |
| --- | --- |
| `ssh_hosts` | List aliases from `~/.ssh/config` with their Connection state. |
| `ssh_exec` | Run one non-interactive command (`host`, `command`, optional `cwd`, `timeoutSec` up to 900, default 120, `sudo`, `async`). Like bash, long commands move to the background automatically; `async: true` backgrounds at once. Monitor with `read proc://<id>`, `wait`, or cancel via `proc://<id>/kill`. |
| `ssh_transfer` | Upload or download a file or directory tree. |

The agent connects lazily by `host`. Output keeps the first and last 200 lines per stream, capped at 64 KB.

**Approvals** open a dialog with *Allow once*, *Always allow on this Host* (commands only) or *Deny*. Host Grants live in memory and end with the omp session.

Transfers: uploads always ask. Downloads ask when a local file would be overwritten or the target is outside the working directory. Symlinks and special files are skipped.

> [!NOTE]
> There is no PTY and no interactive shell. Commands containing `;`, `&`, `||`, redirects, backticks or `$(...)` are never allowlisted.

### Commands

| Command | Description |
| --- | --- |
| `/ssh-manager [host]` | Open the Connection Manager, a persistent screen with tabs **Hosts · Transfers · Security** (`1`/`2`/`3`). Hosts: filter, connect, disconnect, run, upload, download, forget a stored host key, revoke a grant, add a host (optionally saved to `~/.ssh/config`). Transfers: live progress and the last 20 finished. Security: Host Grants and the effective allow/deny rules. In Tern, *Shell in split* opens system `ssh` in a new pane and *Open rules file* opens `pi-ssh.json`; outside Tern the screen falls back to plain lines and keys. omp's built-in `/ssh` always takes precedence over extension commands, so this one is not named `/ssh`. |
| `/ssh-disconnect [host\|all]` | Close one or all Connections. |

Commands you type in the manager run without the allowlist gate; transfers ask only on overwrite.

## Configuration

Optional `~/.omp/agent/pi-ssh.json` extends the built-in rules and is reloaded on every `ssh_exec` call:

```json
{
  "allow": ["kubectl get", "docker ps"],
  "deny": ["cat /etc/shadow"]
}
```

Rules match leading words (`allow`) or words in order with `*` as a gap (`deny`). Deny wins over allow. An invalid file is ignored with a warning.

The built-in allowlist covers `ls`, `cat`, `grep`, `find`, `git status|log|diff|show`, `systemctl status`, `journalctl` and similar. It deliberately omits `awk`, `sed`, `env` and container CLIs.

> [!WARNING]
> Only a subset of OpenSSH config is supported (no `Match` blocks, no multi-hop `ProxyJump`). See [ADR 0002](docs/adr/0002-ssh2-library-transport.md).

## Development

```sh
bun test
```

Unit tests cover the classifier, known_hosts handling, host resolution and output shaping. Integration tests run against an in-process `ssh2.Server`. `src/core` must not import `@oh-my-pi/*`.

Design notes: [GLOSSARY.md](GLOSSARY.md), [ADR 0001](docs/adr/0001-own-command-gate.md), [ADR 0002](docs/adr/0002-ssh2-library-transport.md).
