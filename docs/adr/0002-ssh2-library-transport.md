# ssh2 library transport instead of system OpenSSH

Transport is the `ssh2` npm library, not the system `ssh`/`scp` binaries. It gives persistent Connections (Win32 OpenSSH has no ControlMaster, so every command would pay a handshake), in-process host-key and credential prompts, and SFTP progress callbacks.

## Consequences

- `~/.ssh/config` is parsed by the `ssh-config` package, which supports only a subset of OpenSSH directives (Host, HostName, User, Port, IdentityFile, ProxyJump are honoured; Match blocks and others are ignored).
- Only single-level ProxyJump is supported.
