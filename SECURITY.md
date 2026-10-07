# Security

**Language:** [English](SECURITY.md) | [中文](SECURITY.zh.md)

## Threat Model

### Overview

miao is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Sandboxing

By default, miao does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

There is also an **opt-in kernel sandbox** for the V2 `bash` tool, which is off unless enabled. It builds a seatbelt profile for `sandbox-exec` on macOS and applies Landlock on Linux; `miao-sandbox` reports no backend on Windows.

```jsonc
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

`MIAO_SANDBOX=1` and `MIAO_SANDBOX_DENY_NETWORK=1` override the configuration. Three properties of it belong in a threat model:

- **It is off unless the user turns it on.** `mode` defaults to `"off"`.
- **It fails open.** If a sandbox is requested but no backend is available, `on_unavailable` defaults to `"warn"` and the command runs **unsandboxed**. Set it to `"fail"` to refuse instead.
- **`workspace-write` restricts writes, not reads.** Writes are limited to the active Location, the command's working directory, temp directories, `writable_roots` and paths approved after a blocked write (the command is then rerun with the directory added). Network is allowed unless denied.

If you need true isolation, run miao inside a Docker container or VM.

### Server Mode

Normal CLI/TUI invocations own a window-scoped Runtime in the same process.
Its listener binds to `127.0.0.1` on an ephemeral port, does not advertise over
mDNS, and uses a fresh private credential and Runtime ID. Closing that window
ends its execution and remote connection. The private `miao runtime access`
bridge targets an explicit live Runtime ID; it never starts a daemon. See
[Runtime lifecycle](docs/runtime.md).

`miao serve` is a separate, explicitly started foreground API server. It defaults
to `127.0.0.1`, but `--hostname` or server configuration can expose it to a network;
`--mdns` enables discovery and defaults the hostname to `0.0.0.0` unless overridden.
Its HTTP Basic authentication is enabled with `MIAO_SERVER_PASSWORD` (and optional
`MIAO_SERVER_USERNAME`). Without a password the server starts with an unsecured
listener warning. Access is then available to processes or hosts that can reach
its configured interface; it is not inherently local-only.

Remote Control is enabled explicitly for a particular window through
`/remote-control`. The local Agent makes an outbound connection to a configured
Hub. Hub login authorizes relay access, while locally approved device keys and
scoped, expiring grants authorize session operations. Disabling access or closing
the owner window closes its connection; revoking a device invalidates its grant.
The Hub relays encrypted frames and does not execute local sessions. Legacy IM
bridges and `miao remote` have been removed.

### Out of Scope

| Category                        | Rationale                                                                |
| ------------------------------- | ------------------------------------------------------------------------ |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior               |
| **Permission-system escapes**   | That system is not a sandbox (see above). The kernel sandbox is separate |
| **Requested sandbox gap**       | Documented: `on_unavailable` defaults to `"warn"`. Set it to `"fail"`    |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies  |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary        |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector     |

## Reporting a Security Issue

Use the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/oxdingzg/miao/security/advisories/new)
tab. It stays private until it is published.

You will get an answer saying what happens next, and after that, how the fix is
going. There is no security team here and no response-time commitment - if a
week passes with no reply, ask again on the same thread.
