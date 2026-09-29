<p align="center">
  <strong>miao</strong>
</p>
<p align="center">Same results, faster and cheaper.</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

miao is a terminal AI coding agent for daily engineering work, forked from
[opencode](https://github.com/anomalyco/opencode). It is built around a single constraint:
**produce the same result with less latency and fewer tokens.**

Most coding agents are judged on capability alone. miao treats latency, token use, and cost as
first-class properties of the runtime rather than settings bolted on afterward. The goal is an
agent that starts sooner, finishes a turn sooner, and costs less to run every day — without giving
up model coverage or safety.

## Design principles

- **Latency is a budget.** Startup, first-token, and per-turn latency are measured and held. Hot
  paths run in-process instead of spawning subprocesses or paying per-call process overhead.
- **Tokens and money are measured.** Prompt-cache stability, context epochs, compaction tuning, and
  per-turn cost accounting are part of the runtime, not add-ons. Cost is reported in the provider's
  own currency so totals match the real bill.
- **Provider breadth over lock-in.** One interface adapts to as many models and providers as
  possible, backed by an explicit model catalog.
- **Safety is enforced, not requested.** Rule-based permissions plus an opt-in kernel sandbox
  (macOS seatbelt / Linux Landlock) that limits writes and network at the syscall level — something
  rule-based permissions cannot guarantee.

## Measured performance

The baseline is opencode's TypeScript implementation as it stood in this repository before the
fork's native work, on the same machine (release build, medians). Higher is better.

| Path | opencode (TS) | miao (Rust native) | Speedup | Status |
|---|---|---|---|---|
| edit exact match (12k lines) | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit fuzzy match (12k lines) | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit match + diff stats (12k lines) | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch exact (20k lines) | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim match (20k lines) | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode-normalize (20k lines) | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status small repo (10 files) | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status large repo (2200 files) | 13.6 ms | 5.8 ms | **2.4x** | PoC |

- opencode reads git status with a subprocess model and pays a ~11 ms floor even for 10 files; miao
  reads it in-process with `gix`, scaling with file count.
- Fuzzy matching and unicode normalization are pure CPU paths (2–2.5x). Paths dominated by
  whole-file diff and string assembly gain less (1.1–1.3x), because both sides pay the same O(n)
  cost there.

## Beyond opencode

| Capability | What it does | Status |
|---|---|---|
| Kernel-level sandbox | Opt-in (`MIAO_SANDBOX=1`): macOS seatbelt / Linux Landlock limit writes to the workdir; blocked paths are reported and retried after a prompt. Network is allowed by default (`MIAO_SANDBOX_DENY_NETWORK=1` denies it) | Opt-in |
| In-process git status | `gix`, no subprocess spawn | PoC |
| Independent versioning and update source | `oxdingzg/miao`, versions from `0.0.1`, own releases and auto-update | Merged |
| Cost accounting | Per-turn cost from model rates, session totals, revert-aware | Merged |
| Native-currency pricing | Prices in the provider's own currency (e.g. DeepSeek CNY), so totals match the real bill | Merged |
| Prompt-cache telemetry | Per-turn TTFT and cache-hit ratio, warm / expected-rebuild / miss, optional cache TTL | Merged |
| Compaction tuning (opt-in) | Cheap summarize model, hot-prefix reuse, BPE thresholds, tool-output pruning | Opt-in |
| Autonomous loop | Continue until the todo list is done, guarded by iteration, cost, and stall limits | Experimental (V2 runner) |
| Code Mode | The tool set collapses behind one `execute` tool with a budgeted catalog | Experimental |

The Rust-native edit and patch paths run by default (`MIAO_NATIVE=0` falls back to pure TS); the
remaining native modules are not yet wired into default paths. The process sandbox is wired opt-in
(`MIAO_SANDBOX=1`). Versioning, update source, branding, and cost reporting are merged. Full
comparison in [docs/miao-vs-opencode.en.md](docs/miao-vs-opencode.en.md); integration risks in
[docs/rust-integration-risks.en.md](docs/rust-integration-risks.en.md).

## Architecture

miao is in the final stage of a **V1 → V2 runtime rebuild**. V2, an Effect-native core, is now the
default runtime for the terminal TUI and the browser app; the opencode-derived V1 remains mounted for
compatibility and can be forced with `MIAO_TUI_V2=0` (TUI) or `?protocol=v1` (app). The mechanisms
that matter for latency and cost:

- **Effect-native core (Effect v4).** The V2 runtime is built on Effect, with explicit services,
  typed errors, and scoped resources, so behavior is composed rather than patched in.
- **Durable, event-sourced sessions.** Session history is an append-only event log projected into a
  single-writer read model, so replay, recovery, and cross-process tailing are first-class.
- **Context Epoch.** Each provider-cache baseline is immutable for its epoch; mid-conversation
  context changes are admitted as a durable system message at a safe turn boundary, keeping the
  prompt-cache prefix stable and cheap.
- **Native accelerators.** CPU-bound hot paths (edit, apply_patch, and in-process git status) are
  implemented in a Rust addon called in-process via napi, with a pure-TS fallback; the edit and
  apply_patch paths are wired by default.

Design notes for the V2 runtime live in [CONTEXT.md](CONTEXT.md) and
[specs/v2](specs/v2); the cutover plan is in
[specs/v2/v1-retirement.md](specs/v2/v1-retirement.md).

## Install

macOS / Linux required (Windows builds exist but are not fully verified).

```bash
curl -fsSL https://raw.githubusercontent.com/oxdingzg/miao/main/install | bash

miao auth login <provider>   # credentials are written to auth.json
cd /path/to/project
miao                         # start the TUI
```

Upgrade with `miao upgrade`; the installer places the binary at `~/.miao/bin/miao`.

## Documentation

- [Guide (English)](docs/guide.en.md) — install, configuration, TUI, MCP/LSP/sandbox, the
  autonomous loop, FAQ, and troubleshooting.
- [使用指南（中文）](docs/guide.zh.md) — the same guide in Chinese.
- [miao vs opencode](docs/miao-vs-opencode.en.md) — the full benchmark and capability comparison.
- [Versioning and release](docs/release.en.md) — version scheme and release process.

## Status

miao is pre-1.0 and under active development: the CLI and configuration may change between
releases, and the V1 runtime is still being retired. The daily `miao` binary is the stable command;
`miao-dev` runs from source and `miao-preview` builds the current checkout.

## Built on opencode

miao is a derivative work based on [opencode](https://github.com/anomalyco/opencode), licensed under
the MIT License. miao is not built by, endorsed by, or affiliated with the OpenCode team.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

Run `bun typecheck` from a package directory (for example `packages/miao`) before submitting
changes.

## License

MIT. See [LICENSE](./LICENSE).
