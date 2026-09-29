# miao Guide

<p align="center"><a href="guide.en.md">English</a> | <a href="guide.zh.md">简体中文</a></p>

> [!NOTE]
> miao is a personal, pre-release project and is not open source yet. This guide is written for
> personal and internal use, and aims to cover install, usage, and troubleshooting end to end.

## 1. What this is

miao is a terminal AI coding tool (TUI + HTTP server), forked from
[opencode](https://github.com/anomalyco/opencode). It is not trying to be a large product; it
reflects what the author uses and adjusts daily, along three fixed axes:

- **Faster** — minimal startup, first-token, and per-turn latency.
- **Broader** — one interface that adapts to as many models and providers as possible.
- **Cheaper** — the same result for less time and fewer tokens.

Relationship to opencode: miao is a derivative work under the MIT License, **not built by,
endorsed by, or affiliated with the OpenCode team**. Beyond opencode, miao adds a kernel-level
sandbox, in-process git status, an independent version/update source, cost accounting, and
prompt-cache telemetry (see [README.md](../README.md) and
[miao-vs-opencode.en.md](miao-vs-opencode.en.md)).

## 2. Install and upgrade

macOS / Linux required (Windows builds exist but are not fully verified).

```bash
# stable
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

# a specific version
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash -s -- --version 0.0.1

# from a local binary
./install --binary /path/to/miao
```

The installer places the binary at `~/.miao/bin/miao` and updates PATH unless `--no-modify-path`.

**Three entry points (coexisting, independent)**

| Command | What it is | Data / config | Updates |
|---|---|---|---|
| `miao` | Stable release binary | channel `latest`, DB `miao.db` | background auto-update |
| `miao-dev` | Runs from source; the only entry that sees uncommitted edits | channel `local`, DB `miao-local.db` | manual |
| `miao-preview` | Compiled build of the current checkout (`./script/install-local.sh`) | channel = current branch | none |

`auth.json`, config, and snapshots are shared across channels, so credentials carry over.

**Upgrade / uninstall**

```bash
miao upgrade
miao uninstall
MIAO_DISABLE_AUTOUPDATE=1 miao   # disable auto-update for one run
```

## 3. Quick start

```bash
miao auth login <provider>   # credentials are written to auth.json
miao models                  # list available models
cd /path/to/project
miao                         # start the TUI
```

A typical config (global `~/.config/miao/miao.jsonc` or project `.miao/miao.jsonc`;
`.opencode/` is read as a fallback):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5-5",
  "permission": { "*": "allow" },
  "lsp": true,
  "formatter": true
}
```

## 4. Configuration

Config files merge by precedence: project `.miao/` > global `~/.config/miao/`; `MIAO_CONFIG`
overrides the path. Main fields:

| Field | Purpose |
|---|---|
| `model` | default model (`provider/model`) |
| `default_agent` | default agent |
| `permission` | permission rules (`allow` / `ask` / `deny`, by tool/path); unmatched defaults to `ask` |
| `agents` | custom agents (model, system prompt, permissions, step cap) |
| `lsp` | language servers: `true` enables all built-ins, `false` disables, or a per-name record. **Omitted = all disabled** |
| `formatter` | formatters: `true` enables built-ins, or a per-name record with commands |
| `mcp` | MCP servers (local stdio / remote streamable-http) |
| `compaction` | `prune` old tool output, `summarize_small`, `hot_prefix`, `precise_tokens` |
| `cache` | `ttl_seconds` extends the prompt-cache TTL |
| `cost` | `budget_usd` per-session cost budget (warns and stops continuation) |
| `loop` | autonomous continuation (see §5.8) |
| `shell` | default shell |
| `skills` / `commands` / `instructions` / `references` / `plugins` | skills, commands, instructions, references, plugins |
| `watcher` / `attachments` / `tool_output` / `snapshots` | watcher, attachments, tool-output thresholds, snapshots |
| `providers` | custom providers/models (including native-currency `cost`) |
| `experimental` | experimental flags (e.g. Code Mode) |

**Native currency**: set `providers.<id>.models.<m>.cost` in the provider's own currency (for
example DeepSeek in CNY) so totals match the real bill; `/currency` in the TUI switches the
display currency (defaults to USD, with a static conversion for providers without a declared
currency).

## 5. Daily use

### 5.1 TUI keybindings

The default **leader key is `ctrl+x`**:

| Keys | Action |
|---|---|
| `ctrl+p` | command palette |
| `ctrl+x` `b` | toggle the right sidebar (hidden for child sessions) |
| `ctrl+x` `m` | model picker |
| `ctrl+x` `l` | session list |
| `ctrl+x` `n` | new session |
| `ctrl+x` `t` | themes |
| `ctrl+x` `c` | compact |
| `ctrl+x` `g` | timeline |
| `ctrl+x` `q` | quit |

Rebind in `~/.config/miao/tui.json` (or `keybinds` in miao.jsonc).

### 5.2 Sessions and models

- `/model` or `ctrl+x m` switches models (the last model per agent is remembered).
- `miao session list` / `miao export <sessionID>` manage and export sessions
  (`--format jsonl` writes one message per line for grep/backup).
- `miao run -p "..."` runs once non-interactively.

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
      "remote": { "type": "remote", "url": "https://example.com/mcp" }
    }
  }
}
```

### 5.5 LSP and formatting

- With `lsp: true`, servers lazily activate as files are read, and diagnostics are fed back after
  edits (`LSP errors detected… please fix`).
- With `formatter: true`, `edit` / `write` / `apply_patch` run the matching formatter on success.
- The sidebar shows LSP connection status; **a config change requires restarting miao**.

### 5.6 Kernel-level sandbox (opt-in)

```bash
MIAO_SANDBOX=1 miao                                # writes limited to the workdir (seatbelt / landlock)
MIAO_SANDBOX_DENY_NETWORK=1 MIAO_SANDBOX=1 miao    # also deny network
```

Denied writes are reported and retried after a prompt. Rule-based permissions cannot enforce
this; the sandbox is the kernel backstop.

### 5.7 Cost and cache telemetry

Each provider turn records TTFT, cache-hit ratio, `warm` / `expectedRebuild` / `cacheMiss`, and
cost; session totals and revert-aware rollback are tracked. The sidebar shows `% cached` and
spend.

### 5.8 Autonomous loop (new)

Let the agent keep going round after round until its todos are done:

```jsonc
{ "loop": { "enabled": true, "max_iterations": 25 } }
```

When a drain settles and the session still has open todos, it admits a continuation prompt and
continues. Three guards: max iterations, cost budget (`cost.budget_usd`), and stall detection
(stops after two unchanged todo signatures). The model maintains the list with `todowrite`; the
loop ends naturally when everything is `completed` / `cancelled`.

## 6. Roadmap

miao is mid **V1 → V2 runtime rebuild** (V1 is the opencode-derived implementation; V2 is the
Effect-native core).

- **Cutover** ([specs/v2/v1-retirement.md](https://github.com/oxdingzg/miao/blob/main/specs/v2/v1-retirement.md)):
  Stage 1 detection seam — done. Stage 2 protocol parity — done (`session.todo/children/status/
  shell/skill/diff/fork/command/rename/archive/remove`). Stage 3 old-session visibility — done
  (read fallback + opt-in `miao db backfill`). Stage 4 per-surface write flip and Stage 5 delete
  V1 — not done (they touch the daily engine and need staged verification).
- **Storage hardening**
  ([specs/storage/session-storage-hardening.md](https://github.com/oxdingzg/miao/blob/main/specs/storage/session-storage-hardening.md)):
  `miao db stats` / `vacuum` and `export --jsonl` done; event de-snapshotting, attachment
  externalization, and reclamation await V2.
- Remaining gaps: crash-recovery idempotency, background jobs, MCP progressive discovery/OAuth,
  syscall-level confinement, stronger permission fail-closed.

## 7. FAQ

**Sidebar LSP always says "LSPs are disabled"?**
`lsp` is omitted (omitted means disabled). Add `"lsp": true` and **restart miao** (the running
session reads config at startup).

**`ctrl+x b` does not open the sidebar?**
Child sessions (spawned by task/subagent, non-empty `parent_id`) force-hide the sidebar;
top-level sessions work. Narrow terminals (width ≤ 120) do not show it in `auto` mode, but the
manual toggle still works.

**How do I configure models/providers?**
`miao auth login <provider>` writes credentials; `miao models` lists them; customize under
`providers` in `miao.jsonc`. Use `miao debug` for provider errors.

**Cost does not match the bill?**
Use native-currency pricing (`providers.<id>.models.<m>.cost`), or switch display currency with
`/currency`.

**Native (Rust) path problems?**
`MIAO_NATIVE=0 miao` falls back to the pure-TS edit/apply_patch.

**Can it keep working autonomously like a single long run?**
Use the `loop` config (§5.8), or an external loop `miao run -p "...continue..."`.

**Does it modify my git repo?**
Snapshots use a separate git directory (`~/.local/share/miao/snapshot/…`), so the worktree is not
polluted; edits and commands still require your approval.

## 8. Troubleshooting

```bash
miao db path              # database path
miao db stats             # per-table/event usage (find bloat)
miao db vacuum            # checkpoint + VACUUM to reclaim free pages
miao db backfill          # convert legacy V1 session messages to the V2 projection (idempotent, opt-in)
miao export <sessionID> --format jsonl
MIAO_CONFIG=/path/miao.jsonc miao
```

Logs live in `~/.local/share/miao/log/`. Database bloat comes mainly from legacy V1 per-delta
events; until V1 is retired, use `miao db stats` to monitor and `vacuum` to reclaim free pages.

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
