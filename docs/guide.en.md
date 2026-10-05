# miao Guide

<p align="center"><a href="guide.en.md">English</a> | <a href="guide.zh.md">简体中文</a></p>

> [!NOTE]
> miao is pre-1.0 and under active development, so the CLI and configuration may change between
> releases. This guide covers install, usage, and troubleshooting end to end.

## 1. What miao helps you do

miao is an open-source coding agent with a terminal UI, HTTP server, and browser interface. It focuses on the work around model calls: durable sessions, context efficiency, collaboration, and visible cost.

Use it to explore a repository, implement a change, investigate a failing test, or delegate focused research. Connect the providers you prefer, configure project tools, and continue the conversation as the task evolves. Model selection and MCP are part of the workflow; miao's runtime work is described in the [overview](../README.md) and [availability comparison](miao-vs-opencode.en.md).

A useful first task is: “Find the cause of this failure, make the smallest appropriate fix, run the relevant checks, and explain the diff.” Add constraints while the agent works rather than starting a second conversation.

miao is developed under the MIT License. This guide describes the current checkout; installed releases may lag source changes.

## 2. Install and upgrade

macOS, Linux and Windows. The Windows installer is checked in CI; terminal rendering on Windows is still being verified.

```bash
# stable
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

# a specific version
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash -s -- --version 0.0.1

# from a local binary
./install --binary /path/to/miao
```

On Windows, run the PowerShell installer (Windows PowerShell 5.1 or PowerShell 7). It installs to `~\.miao\bin` and adds that directory to your user PATH:

```powershell
irm https://raw.githubusercontent.com/oxdingzg/miao/main/install.ps1 | iex

# a specific version
$env:MIAO_VERSION = "0.0.33"; irm https://raw.githubusercontent.com/oxdingzg/miao/main/install.ps1 | iex
```

The installer places the binary at `~/.miao/bin/miao` and updates PATH unless `--no-modify-path`.

**Three entry points (coexisting, independent)**

| Command        | What it is                                                           | Data / config                       | Updates                |
| -------------- | -------------------------------------------------------------------- | ----------------------------------- | ---------------------- |
| `miao`         | Stable release binary                                                | channel `latest`, DB `miao.db`      | background auto-update |
| `miao-dev`     | Runs from source; the only entry that sees uncommitted edits         | channel `local`, DB `miao-local.db` | manual                 |
| `miao-preview` | Compiled build of the current checkout (`./script/install-local.sh`) | channel = current branch            | none                   |

`auth.json`, config, and snapshots are shared across channels, so credentials carry over.

**Upgrade / uninstall**

```bash
miao upgrade
miao uninstall
MIAO_DISABLE_AUTOUPDATE=1 miao   # disable auto-update for one run
```

## 3. Quick start

```bash
miao providers login   # credentials are written to auth.json
miao models                  # list available models
cd /path/to/project
miao                         # start the TUI
```

Replace `<provider>/<model>` with an entry from `miao models`. A typical config (global `~/.config/miao/miao.jsonc` or project `.miao/miao.jsonc`;
`.opencode/` is read as a fallback):

```jsonc
{
  "$schema": "https://mtty.dev/miao/config.json",
  "model": "<provider>/<model>",
  "permission": { "*": "ask" },
  "lsp": true,
  "formatter": true,
}
```

## 4. Configuration

Config files merge by precedence: project `.miao/` > global `~/.config/miao/`; `MIAO_CONFIG`
overrides the path. Main fields:

| Field                                                             | Purpose                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model`                                                           | default model (`provider/model`)                                                                                   |
| `default_agent`                                                   | default agent                                                                                                      |
| `permission`                                                      | permission rules (`allow` / `ask` / `deny`, by tool/path); unmatched defaults to `ask`                             |
| `agents`                                                          | custom agents (model, system prompt, permissions, step cap)                                                        |
| `lsp`                                                             | language servers: `true` enables all built-ins, `false` disables, or a per-name record. **Omitted = all disabled** |
| `formatter`                                                       | formatters: `true` enables built-ins, or a per-name record with commands                                           |
| `mcp`                                                             | MCP servers (local stdio / remote streamable-http)                                                                 |
| `compaction`                                                      | `prune` old tool output, `threshold` ratio, `summarize_small`, `hot_prefix`, `precise_tokens`                      |
| `cache`                                                           | `ttl_seconds` extends the prompt-cache TTL                                                                         |
| `cost`                                                            | `budget_usd` per-session cost budget (warns and stops continuation)                                                |
| `loop`                                                            | autonomous continuation (see §5.8)                                                                                 |
| `shell`                                                           | default shell                                                                                                      |
| `skills` / `commands` / `instructions` / `references` / `plugins` | skills, commands, instructions, references, plugins                                                                |
| `watcher` / `attachments` / `tool_output` / `snapshots`           | watcher, attachments, tool-output thresholds, snapshots                                                            |
| `providers`                                                       | custom providers/models (including native-currency `cost`)                                                         |
| `experimental`                                                    | experimental flags (e.g. Code Mode)                                                                                |

**Native currency**: set `providers.<id>.models.<m>.cost` in the provider's own currency (for
example DeepSeek in CNY) to estimate costs using the declared currency; `/currency` in the TUI switches the
display currency (defaults to USD, with a static conversion for providers without a declared
currency).

## 5. Daily use

### 5.1 TUI keybindings

The default **leader key is `ctrl+x`**:

| Keys         | Action                                               |
| ------------ | ---------------------------------------------------- |
| `ctrl+p`     | command palette                                      |
| `ctrl+x` `b` | toggle the right sidebar (hidden for child sessions) |
| `ctrl+x` `m` | model picker                                         |
| `ctrl+x` `l` | session list                                         |
| `ctrl+x` `n` | new session                                          |
| `ctrl+x` `t` | themes                                               |
| `ctrl+x` `c` | compact                                              |
| `ctrl+x` `g` | timeline                                             |
| `ctrl+x` `q` | quit                                                 |

Rebind in `~/.config/miao/tui.json` (or `keybinds` in miao.jsonc).

### 5.2 Sessions and models

- `/model` or `ctrl+x m` switches models (the last model per agent is remembered).
- `miao session list` / `miao export <sessionID>` manage and export sessions
  (`--format jsonl` writes one message per line for grep/backup).
- `miao run "..."` runs once non-interactively.

### 5.3 Commands and skills

- Slash commands come from the `commands` config and are triggered by `/`.
- Skills are matched by description; the model loads skill content with the `skill` tool.
- `miao agent create` generates a custom agent.

### 5.4 MCP

Configure local or remote servers under `mcp.servers`; their tools appear as
`mcp__<server>__<tool>`:

```jsonc
{
  "mcp": {
    "servers": {
      "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] },
      "remote": { "type": "remote", "url": "https://example.com/mcp" },
    },
  },
}
```

### 5.5 LSP and formatting

- With `lsp: true`, servers lazily activate as files are read, and diagnostics are fed back after
  edits (`LSP errors detected… please fix`).
- With `formatter: true`, `edit` / `write` / `apply_patch` run the matching formatter on success.
- The sidebar shows LSP connection status; **a config change requires restarting miao**.

### 5.6 Kernel-level sandbox (opt-in)

The V2 `bash` tool can run each command under the OS sandbox: seatbelt on macOS, Landlock on Linux. Windows has no backend. Enable it in config:

```jsonc
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

`MIAO_SANDBOX=1` and `MIAO_SANDBOX_DENY_NETWORK=1` override the config. `workspace-write` leaves reads unrestricted and allows writes only to the active Location, the command's working directory, temp directories, `writable_roots`, and paths you approve after a blocked write (the command is rerun with the added directory). Network is allowed unless denied. If the sandbox is requested but no backend is available, `on_unavailable` defaults to `"warn"` and the command runs unsandboxed; set `"fail"` to refuse instead. See the [integration matrix](miao-vs-opencode.en.md#native-tools-and-sandbox-where-they-apply) for platform limits.

### 5.7 Cost and cache telemetry

Each provider turn records TTFT, cache-hit ratio, `warm` / `expectedRebuild` / `cacheMiss`, and
cost; session totals are tracked. Costs are estimates based on model rates, not provider invoices. The sidebar shows `% cached` and
spend.

### 5.8 Autonomous loop (V2, opt-in)

Let the agent keep going round after round until its todos are done:

```jsonc
{ "loop": { "enabled": true, "max_iterations": 25 } }
```

When a drain settles and the session still has open todos, it admits a continuation prompt and
continues. Three guards: max iterations, cost budget (`cost.budget_usd`), and stall detection
(stops after two unchanged todo signatures). The model maintains the list with `todowrite`; the
loop ends naturally when everything is `completed` / `cancelled`.

### 5.9 Steer a task, retain the conversation

In V2, an input is admitted durably before execution is scheduled. Input sent during a running task steers at the next safe provider-turn boundary while that task needs continuation. Explicit `queue` delivery waits until the session would otherwise become idle; these are separate semantics, not immediate interruption. Normal TUI submission uses steer delivery.

For example, after asking for a bug fix, add “Keep the public API unchanged and run the package tests.” The pending-input display records that the requirement is waiting to be promoted. The public V2 API also supports queue delivery and `resume: false` for admission without execution.

Reopen sessions from the session list or export them with `miao export <sessionID> --format jsonl`. Persisted history survives a terminal lifetime, but a crash does not automatically retry unfinished provider execution. Resume deliberately, inspect completed changes, and verify any commands with external side effects before repeating them.

### 5.10 Specialist agents and project-local messages

Ask the agent to delegate a bounded task—such as finding callers of an API or reviewing a migration—to a specialist subagent. The `task` tool returns a child session that can be continued with its session ID. Its separate conversation keeps detailed investigation out of the main context.

V2's `list_sessions` discovers project peers, and `send_message` accepts a session ID or `@slug`. Messages are attributed to their sender, admitted as queued inputs, and subject to the `message` permission and an inbound queue limit. Cross-project targets are rejected. This is process-local coordination, not a cross-machine worker service.

### 5.11 Tune context and cost deliberately

```jsonc
{
  "loop": { "enabled": true, "max_iterations": 25 },
  "cost": { "budget_usd": 5 },
  "compaction": { "prune": true },
  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },
}
```

This optional project configuration combines continued todo work, a scheduling budget, old-output pruning, and a bound on each tool's model-visible output. A budget does not interrupt an in-flight turn and is not a billing cap. Output files are temporary; the bounded transcript is the durable record. Tool-output pruning is on by default (disable with `"prune": false`). Automatic compaction triggers at `threshold` (default `0.9`) of the window using the provider's reported prompt tokens, so it runs before the window fills rather than at the last moment. Enable small-model summaries or hot-prefix compaction separately after checking that they suit your provider and workload.

Content that a compaction removed from the model window stays durable on disk. The `recall` tool searches that history by keyword, so an agent can recover a dropped detail instead of re-reading files or repeating finished work.

## 6. Runtime status and ongoing work

All shipped clients use the single V2 session runtime; the V1 session runtime and its `/session/*` routes have been removed.

- [V1 retirement](../specs/v2/v1-retirement.md) records the removal and the remaining compatibility surfaces (database migration and non-session legacy routes).
- [Session storage](../specs/storage/session-storage-hardening.md) tracks storage design. Use `miao db stats`, `miao db vacuum`, and JSONL exports to inspect and maintain local records.
- [Agent concurrency](../specs/v2/agent-concurrency.md) designs non-blocking subagents and wake-on-completion so long-running work does not stall a Session.
- Automatic post-crash execution continuation and clustered ownership are not implemented. The OS sandbox is built into the V2 `bash` tool but remains opt-in; see the [availability matrix](miao-vs-opencode.en.md).

## 7. FAQ

**Sidebar LSP always says "LSPs are disabled"?**
`lsp` is omitted (omitted means disabled). Add `"lsp": true` and **restart miao** (the running
session reads config at startup).

**`ctrl+x b` does not open the sidebar?**
Child sessions (spawned by task/subagent, non-empty `parent_id`) force-hide the sidebar;
top-level sessions work. Narrow terminals (width ≤ 120) do not show it in `auto` mode, but the
manual toggle still works.

**How do I configure models/providers?**
`miao providers login` writes credentials; `miao models` lists them; customize under
`providers` in `miao.jsonc`. Use `miao debug` for provider errors.

**How do I use my Command Code subscription?**
Connect once with `miao auth login commandcode` (a browser-assisted login), or set
`CMD_API_KEY` to an API key from [commandcode.ai Studio](https://commandcode.ai/studio/).
Its models are discovered from your account when it connects. Command Code uses its CLI
subscription endpoint rather than the documented Provider API, so model capabilities and
pricing are conservative until the catalog reports them.

**Cost does not match the bill?**
Use native-currency pricing (`providers.<id>.models.<m>.cost`), or switch display currency with
`/currency`.

**Native (Rust) addon problems?**
`MIAO_NATIVE=0` disables the addon. The V2 edit/patch tools are TypeScript; the addon backs the OS sandbox runner. See the [comparison matrix](miao-vs-opencode.en.md).

**Can it keep working autonomously like a single long run?**
Use the `loop` config (§5.8), or an external loop `miao run --continue "...continue..."`.

**Does it modify my git repo?**
Snapshots use a separate git directory (`~/.local/share/miao/snapshot/…`), so the worktree is not
polluted; edits and commands follow the configured permission rules.

## 8. Troubleshooting

```bash
miao db path              # database path
miao db stats             # per-table/event usage (find bloat)
miao db vacuum            # checkpoint + VACUUM to reclaim free pages
miao db backfill          # project legacy V1 session messages into the V2 schema (idempotent)
miao db compact           # after backfill: drop the retired message/part tables and their events
miao export <sessionID> --format jsonl
MIAO_CONFIG=/path/miao.jsonc miao
```

Logs live in `~/.local/share/miao/log/`. In databases written before V2, bloat comes mainly from
legacy per-delta events; use `miao db stats` to monitor, `miao db compact` to retire the old tables,
and `vacuum` to reclaim free pages.

## 9. Development

```bash
bun install
bun run dev                     # run from source (same as miao-dev)
bun --cwd packages/miao typecheck
bun --cwd packages/miao test
./script/install-local.sh       # build and install miao-preview
```

## License

MIT. See [LICENSE](../LICENSE).
