# Security

**Language:** [English](SECURITY.md) | [中文](SECURITY.zh.md)

## Threat Model

### Overview

Miao is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Sandboxing

By default, MIAO does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

There is also an **opt-in kernel sandbox** for the V2 `bash` tool, which is off unless enabled. It builds a seatbelt profile for `sandbox-exec` on macOS and applies Landlock on Linux; `miao-sandbox` reports no backend on Windows.

```jsonc
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

`MIAO_SANDBOX=1` and `MIAO_SANDBOX_DENY_NETWORK=1` override the configuration. Three properties of it belong in a threat model:

- **It is off unless the user turns it on.** `mode` defaults to `"off"`.
- **It fails open.** If a sandbox is requested but no backend is available, `on_unavailable` defaults to `"warn"` and the command runs **unsandboxed**. Set it to `"fail"` to refuse instead.
- **`workspace-write` restricts writes, not reads.** Writes are limited to the active Location, the command's working directory, temp directories, `writable_roots` and paths approved after a blocked write (the command is then rerun with the directory added). Network is allowed unless denied.

If you need true isolation, run MIAO inside a Docker container or VM.

### Server Mode

Server mode is opt-in: it starts with `miao serve`, or `miao remote` for the chat bridges, and is not running otherwise.

The service listens on **127.0.0.1 only** and does not advertise itself over mDNS, so it is reachable from this machine rather than from the network.

Authentication is HTTP Basic Auth, turned on by setting `MIAO_SERVER_PASSWORD`. Without it the service still starts, and says so itself:

> MIAO_SERVER_PASSWORD 没有设置，本机其它进程可以不经鉴权访问 127.0.0.1 上的服务

That is the exposure to weigh: not a remote attacker, but any other process on your machine. An unauthenticated instance is local-only by construction; set the password when local-only is not good enough. Because the service is opt-in and loopback-bound by design, its behaviour in that configuration is not a vulnerability.

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
