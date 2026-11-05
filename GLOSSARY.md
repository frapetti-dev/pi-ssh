# pi-ssh glossary

Domain language for the pi-ssh omp extension.

- **Host**: a named SSH target: an alias from the user's SSH config, or an ad-hoc `user@host[:port]`.
- **Connection**: a live, authenticated link to one Host, reused by every Remote Command and Transfer to that Host until disconnected or the omp session ends.
- **Jump Host**: a Host through which a Connection to another Host is tunnelled (one level).
- **Remote Command**: one non-interactive command run on a Host, yielding exit status, stdout, stderr. Never an interactive shell.
- **Transfer**: a copy of a file or directory tree between the local machine and a Host (Upload or Download).
- **Allowlist**: the set of read-only command shapes that may run without asking.
- **Approval**: the user's decision on a Remote Command or Transfer the Allowlist does not cover: Allow once, Always allow on this Host, or Deny.
- **Host Grant**: the in-memory "always allow on this Host" permission. It ends with the omp session.
- **Host Key Trust**: first-use acceptance of a Host's key after showing its fingerprint. A changed key is never trusted.
- **Connection Manager**: the `/ssh-manager` screen where the user manages Hosts, Connections, Transfers, Host Grants and stored host keys.
- **Forget (a host key)**: remove a Host's stored keys so the next Connection repeats Host Key Trust.

## Avoid

- "session" for SSH concepts: it means the omp chat session. Use Connection.
- "server": use Host.
