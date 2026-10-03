# Security

**Language:** [English](SECURITY.md) | [中文](SECURITY.zh.md)

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

Miao is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Sandboxing

By default, Miao does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

There is also an **opt-in kernel sandbox** for the V2 `bash` tool, which is off unless enabled. It builds a seatbelt profile for `sandbox-exec` on macOS and applies Landlock on Linux; `miao-sandbox` reports no backend on Windows.

```jsonc
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

`MIAO_SANDBOX=1` and `MIAO_SANDBOX_DENY_NETWORK=1` override the configuration. Three properties of it belong in a threat model:

- **It is off unless the user turns it on.** `mode` defaults to `"off"`.
- **It fails open.** If a sandbox is requested but no backend is available, `on_unavailable` defaults to `"warn"` and the command runs **unsandboxed**. Set it to `"fail"` to refuse instead.
- **`workspace-write` restricts writes, not reads.** Writes are limited to the active Location, the command's working directory, temp directories, `writable_roots` and paths approved after a blocked write (the command is then rerun with the directory added). Network is allowed unless denied.

If you need true isolation, run Miao inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `MIAO_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                                |
| ------------------------------- | ------------------------------------------------------------------------ |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior               |
| **Permission-system escapes**   | That system is not a sandbox (see above). The kernel sandbox is separate |
| **Requested sandbox gap**       | Documented: `on_unavailable` defaults to `"warn"`. Set it to `"fail"`    |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies  |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary        |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector     |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/oxdingzg/miao/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, please follow up on the advisory thread.
