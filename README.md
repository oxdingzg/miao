<p align="center">
  <strong>miao</strong>
</p>
<p align="center">Your models. Your workflow. Less wasted context.</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>
<p align="center">
  <a href="https://mtty.dev/miao">Website</a> · <a href="#quick-start">Quick start</a> · <a href="#why-miao">Why miao</a> · <a href="docs/guide.en.md">Guide</a> · <a href="https://github.com/oxdingzg/miao/releases">Releases</a> · <a href="#related-projects">Related projects</a>
</p>

---

**miao is an open-source AI coding agent for developers who want to get real work done—and understand what it costs.** Work in your terminal, use the models you choose, and let the agent explore a repository, edit code, run commands, and check its work.

miao focuses on the engineering around the model: **context efficiency, durable sessions, collaboration, and control over long-running work.** Its aim is the same useful result with less waiting and fewer wasted tokens.

## See it in action

![Current miao terminal UI: an inline edit diff, response and context telemetry](docs/images/miao.png?v=20261004)

The terminal and browser captures below use the same **illustrative session**, imported into the real application without a model request. Captured on 2026-10-04 with miao v0.1.0; the opt-in mini interface is from the current v0.1.1 development build and uses its built-in demo mode.

| Choose your provider                                                                             | Review in the browser                                                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| ![Browsing available services in the provider picker](docs/images/miao-providers.gif?v=20261004) | ![Browser workspace with an expanded code diff and a draft follow-up prompt](docs/images/miao-web.png?v=20261004) |

| Compact interactive mode · development preview                                                                  | Review before allowing an edit · development preview                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Mini demo with task progress, an edit diff and a multi-select question](docs/images/miao-mini.gif?v=20261004) | ![Mini edit-permission prompt showing the diff and Allow once, Allow always and Reject choices](docs/images/miao-permission.png?v=20261004) |

More short, controllable demos: **[miao on mtty.dev](https://mtty.dev/miao#screens)**.

## Why miao

### Choose the model that fits the work

Use multiple providers in one interface, switch models within a session, and configure specialist agents with their own models and permissions. The provider catalog and custom provider configuration let you choose for reasoning quality, speed, or price rather than rebuilding your workflow around one vendor.

### Keep long tasks moving—and steer as you go

Add a requirement while the agent is working. V2 saves the input before scheduling execution and brings it into the conversation at a safe provider-turn boundary. Explicit queued inputs wait until the current work would otherwise become idle. You can refine the task without starting another conversation or interrupting every tool call.

### Give collaboration its own context

Delegate a scoped task to a specialist subagent and continue that subagent session later. V2 also provides `list_sessions` and `send_message`: agents can discover and message other sessions in the same project, subject to permissions. Research and focused investigations can live in their own conversations while the main session keeps the overall objective.

### See where your tokens and money go

Per-turn usage, estimated cost, time to first token, and prompt-cache telemetry make performance visible. Context Epochs preserve an immutable system-context baseline and admit changes chronologically, helping keep cache prefixes reusable. Optional output pruning, compaction tuning, cache TTL, and session budgets give you controls for longer tasks.

Cost estimates use configured model rates and provider currency metadata. They are useful for understanding a session; your provider's billing remains authoritative.

### Keep a record you can continue and inspect

V2 uses durable prompt admission and an event-backed session history. List, reopen, fork, and export sessions instead of treating each terminal window as a disposable chat. Large tool results are bounded in model context, with full output retained in temporary files when available.

Durable history does **not** imply automatic execution recovery after a crash: unfinished provider work requires an explicit resume, and arbitrary commands are not guaranteed to run exactly once.

## Built for everyday engineering

| What you need                         | What miao provides                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Understand an unfamiliar repository   | File reading, search, project instructions, skills, and specialist subagents                                |
| Implement and verify a change         | File edits and patches, shell commands, optional LSP diagnostics and formatting                             |
| Compare models without changing tools | In-session model selection, provider configuration, per-agent models and reasoning variants where supported |
| Work through a larger task            | Todos, mid-task input, durable sessions, and an opt-in autonomous continuation loop                         |
| Connect your own tools                | Local and remote MCP servers, custom commands, skills, and plugins                                          |
| Review and reuse work                 | Diffs, session forks, history export, and permission prompts                                                |
| Integrate with another application    | HTTP server, browser UI, CLI automation, and generated Promise / Effect clients in the workspace            |

**Try a concrete task:** “Find the cause of this failing test, fix it, run the relevant checks, and explain the diff.” Then add a constraint while it works: “Preserve the public API and avoid new runtime dependencies.”

## Quick start

Install on macOS or Linux with the bash script, or on Windows from PowerShell:

```powershell
irm https://mtty.dev/miao/install.ps1 | iex   # Windows: PowerShell 5.1 or 7
```

Windows terminal rendering is still being verified; see the [Windows verification notes](docs/windows-vt-verification.en.md).

Windows binaries are currently unsigned.

```bash
curl -fsSL https://mtty.dev/miao/install | bash   # redirects to this repo's install script

miao providers login          # choose a provider and connect your account / API key
cd /path/to/project
miao                          # start the terminal UI
```

Inside the TUI, use `ctrl+p` for the command palette or `ctrl+x m` for model selection. Run `miao models` to inspect available models.

```bash
miao run "Explain this repository's architecture and identify its main entry points"
miao web                      # open the browser interface
miao upgrade                  # update the release binary
```

The installer places the release command at `~/.miao/bin/miao`. Start with the [guide](docs/guide.en.md) for configuration, permissions, MCP, LSP, and troubleshooting.

## Longer tasks, with limits

The V2 autonomous loop is opt-in. It continues while todos remain open, with iteration and stall guards. A cost budget stops scheduling further provider turns after the estimated session cost reaches the threshold; it is not a hard cap on a provider bill or on a turn already in flight.

```jsonc
{
  "loop": { "enabled": true, "max_iterations": 25 },
  "cost": { "budget_usd": 5 },
  "compaction": { "prune": true },
}
```

Place this in `.miao/miao.jsonc` for a project or `~/.config/miao/miao.jsonc` globally. These settings are optional; see the [configuration guide](docs/guide.en.md#4-configuration) before tuning them.

## Remote Control

Use `/remote-control` in the TUI to configure a self-hosted relay and pair or revoke App/Web devices. The legacy WeChat/QQ connectors and local IM session Router have been removed. See [Runtime behavior](docs/runtime.md) and [relay setup](packages/remote-control/README.md).

## Performance work you can inspect

miao includes Rust accelerators and benchmarks against this repository's earlier TypeScript implementation. Selected recorded measurements, on the same machine using release builds and medians:

| Isolated operation                     | TypeScript baseline | Rust native | Speedup |
| -------------------------------------- | ------------------- | ----------- | ------- |
| Edit fuzzy match, 12k lines            | 0.76 ms             | 0.39 ms     | 1.9×    |
| Patch Unicode normalization, 20k lines | 13.06 ms            | 5.21 ms     | 2.5×    |
| Git status, 10 files                   | 12.3 ms             | 1.0 ms      | 11.9×   |

These are **component benchmarks, not end-to-end task speedups or comparisons with today's upstream release**. The primitives behind them did not leave with the V1 tools: V2's `edit` and `apply_patch` call the same native matching and derivation whenever the addon is loaded, which it is by default, and `MIAO_NATIVE=0` falls back to the TypeScript implementations. The addon also backs the opt-in OS sandbox runner, and in-process Git remains a prototype. See the [full comparison and availability matrix](docs/miao-vs-opencode.en.md).

### Public baseline: startup, memory, idle cost, crash recovery

Measured 2026-10-02 on an Apple M2 with 16 GB RAM, macOS 26.5. Each run launches the compiled TUI in a
160×45 tmux pane in an empty git repository and waits until the prompt renders. The two builds ran
alternately, 6 starts and 2 two-minute idle runs each. Other agents were running on the machine (1-minute load
average 3.5–12.4), so treat the absolute numbers as an upper bound; the comparison is like for like.

| Metric                             | 0.0.31 release | `main` @ `a230e1302` | Phase 0 target |
| ---------------------------------- | -------------- | -------------------- | -------------- |
| Launch to prompt (median of 6)     | 2.27 s         | 1.82 s               | < 2.5 s        |
| CPU time spent reaching the prompt | 3.3 s          | 2.4 s                | —              |
| RSS when the prompt appears        | ~1,080 MB      | ~700 MB              | —              |
| RSS after 2 minutes idle           | 1,240–1,380 MB | 853 MB               | < 600 MB       |
| CPU while idle (minutes 1–2)       | 2.0–2.6 %      | 2.2–2.3 %            | < 1 %          |

Crash recovery (0.0.31): killing the process with `SIGKILL` while a `bash` tool call was running lost no
messages; `miao -c` reopened the session and the next prompt continued it. Three gaps remain: the interrupted
tool call still shows as running until the next turn starts, the child process it started keeps running, and
nothing resumes automatically.

Idle RSS and idle CPU still miss the Phase 0 targets; see [specs/architecture.md](specs/architecture.md).

## Status and architecture

miao is pre-1.0. The V1 session runtime and its legacy `/session/*` routes have been removed, so every shipped client runs the single V2 core. V2 uses Effect services, Location-scoped tools, durable inboxes, event-backed history, and Context Epochs. Local execution coordination is process-local; clustered execution and automatic crash continuation are not implemented.

| Capability                                                                     | Availability                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| V2 sessions, prompt admission, context epochs, project-local session messaging | Implemented                                                           |
| Autonomous continuation, cost budgets, pruning and compaction tuning           | Opt-in; behavior varies by setting                                    |
| Code Mode (`MIAO_EXPERIMENTAL_CODE_MODE=1`)                                    | Experimental                                                          |
| OS sandbox for bash                                                            | V2; opt-in through `sandbox` config or `MIAO_SANDBOX=1` (macOS/Linux) |
| Legacy database migration (`miao db backfill` / `compact` / `restore`)         | Retained for databases written before V2                              |
| Generated clients and embedded Effect host                                     | Private workspace packages; API still evolving                        |

### From V1 to V2

V1 was the session runtime miao inherited from opencode; V2 is miao's rewritten core. The V1 session runtime, its legacy tools, and the `/session/*`, `/permission/*`, `/question/*`, and `/sync/*` routes have been removed, so all shipped clients run V2. Two compatibility surfaces remain: the database migration layer that reads history written before V2, and the non-session legacy routes still being migrated to `/api/*`.

| Concern                                                      | Status                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Session execution, tools, permissions                        | V2 only                                                  |
| `/session/*` routes and legacy session methods in the JS SDK | No longer served by the server                           |
| Old `message` / `part` tables                                | Read by `miao db backfill`; dropped by `miao db compact` |
| Portable export and import (`miao export` / `import`)        | Retained                                                 |
| Configuration written in the old shape                       | Still read by the V2 config loader                       |
| Non-session legacy routes (`/config`, `/mcp`, `/lsp`, …)     | Still served; `/api/*` migration in progress             |

See [specs/v2/v1-retirement.md](specs/v2/v1-retirement.md) and [specs/architecture.md](specs/architecture.md).

Use `miao` for releases, `miao-dev` for source iteration, and `miao-preview` for compiled checkout validation. New source features may not yet be in the installed release.

## Related projects

### Local defaults and optional services

miao runs locally without a miao or OpenCode account. Connect your chosen model provider directly with its API key or supported OAuth method.

- Model metadata comes from miao's own catalog (mtty.dev), falling back to the public [models.dev](https://models.dev) catalog; miao-maintained providers that models.dev does not list yet (currently Command Code) are merged on top. Builds bundle a snapshot for offline startup. Pin a source with `MIAO_MODELS_URL`, or select an exact catalog with `MIAO_MODELS_PATH`.
- [Command Code](https://commandcode.ai) is available as a subscription provider: connect it with `miao auth login commandcode` (browser-assisted) or `CMD_API_KEY`, and its models are discovered from the account at runtime.
- Release notes and updates come from [oxdingzg/miao releases](https://github.com/oxdingzg/miao/releases).
- Sharing has no default backend. Configure `enterprise.url` in `miao.json` to enable a compatible server; shared conversation content is sent only to that configured server.
- MIAO has no Console account or organization support. `MIAO_CONSOLE_URL` only exposes Console OAuth for the OpenCode provider integration; a custom server can specify `MIAO_CONSOLE_CLIENT_ID`.
- OpenCode Zen / Go remain optional third-party model providers, with their actual OpenCode service names and endpoints.

| Project                    | What it is                                                                                                                         | Links                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **miao** (this repository) | AI coding agent for the terminal                                                                                                   | [mtty.dev/miao](https://mtty.dev/miao) · [docs](https://mtty.dev/docs/miao) · [oxdingzg/miao](https://github.com/oxdingzg/miao) |
| **mtty**                   | GPU-rendered terminal written in Rust (macOS, Linux, Windows) that shows which agent in a pane is working, waiting on you, or done | [mtty.dev/mtty](https://mtty.dev/mtty) · [oxdingzg/mtty](https://github.com/oxdingzg/mtty)                                      |
| **mtty.dev**               | The website and documentation for both                                                                                             | [mtty.dev](https://mtty.dev)                                                                                                    |

miao and mtty are separate projects, and each works without the other. Run miao inside an mtty pane and it reports its state (working, waiting for you, done, error) to mtty, which badges the pane, notifies you when the agent needs you, and sends your queued prompt when it goes idle. Outside mtty the report does nothing. `miaotty` was a personal macOS prototype of that terminal and has been replaced by mtty.

## Documentation and development

- [Usage guide](docs/guide.en.md) · [使用指南](docs/guide.zh.md)
- [miao vs its opencode baseline](docs/miao-vs-opencode.en.md) — measurements, differences, and integration status
- [Release workflow](docs/release.en.md) — versions, builds, and publishing
- [Runtime design](CONTEXT.md) · [V2 specifications](specs/v2) — session, context, and client contracts

Requires [Bun](https://bun.sh) for development:

```bash
bun install
bun run dev
# Run checks in the package you changed, for example:
cd packages/miao
bun typecheck
```

miao is released under the MIT License. See [LICENSE](LICENSE).
