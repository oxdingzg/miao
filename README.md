<p align="center">
  <strong>miao</strong>
</p>
<p align="center">Same results, faster and cheaper.</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

miao is a personal AI coding tool for my own daily work, forked from [opencode](https://github.com/anomalyco/opencode). I could never settle on an existing tool: there was always something unsatisfying or inconvenient, and the fixes I made never survived the next upgrade. So instead of patching around it, I forked opencode and let my own changes live here. There is no grand target — miao simply reflects what I use and adjust day to day.

Where those adjustments tend to land:

- **Faster** — minimal startup, first-token and per-turn latency.
- **Broader** — one interface that adapts to as many models and providers as possible.
- **Cheaper** — less time and fewer tokens for the same result.

> [!NOTE]
> miao is currently a private, pre-release project. It is not open source yet.

## Performance and capability vs opencode

miao is a fork of opencode, so the baseline below is opencode's TS implementation as it stood in this repo before the fork, measured on the same machine (release, medians). Higher is better.

| Item | opencode (TS) | miao (Rust native) | Speedup | Status |
|---|---|---|---|---|
| edit exact match (12k lines) | 0.21 ms | 0.12 ms | **1.7x** | PoC |
| edit fuzzy match (12k lines) | 0.76 ms | 0.39 ms | **1.9x** | PoC |
| edit match + diff stats (12k lines) | 2.03 ms | 1.78 ms | 1.14x | PoC |
| apply_patch exact (20k lines) | 1.67 ms | 1.28 ms | **1.3x** | PoC |
| apply_patch trim match (20k lines) | 3.47 ms | 1.76 ms | **2.0x** | PoC |
| apply_patch unicode-normalize (20k lines) | 13.06 ms | 5.21 ms | **2.5x** | PoC |
| git status small repo (10 files) | 12.3 ms | 1.0 ms | **11.9x** | PoC |
| git status large repo (2200 files) | 13.6 ms | 5.8 ms | **2.4x** | PoC |

- opencode reads git status with a subprocess model (~11 ms floor even for 10 files); miao uses `gix` in-process, scaling with file count.
- Fuzzy matching and unicode normalization are pure CPU paths (2-2.5x); whole-file diff/string assembly is dominated by the same O(n) cost on both sides (1.1-1.3x).

Beyond speed, miao adds:

| Capability | What it does | Status |
|---|---|---|
| Kernel-level sandbox | Opt-in (`MIAO_SANDBOX=1`): macOS seatbelt / Linux Landlock limit writes to the workdir; blocked paths reported and retried after a prompt. Network allowed by default (`MIAO_SANDBOX_DENY_NETWORK=1` denies it). Rule-based permissions cannot enforce this | Opt-in |
| In-process git status | `gix`, no subprocess spawn | PoC |
| Independent versioning & update source | `oxdingzg/miao`, versions from `0.0.1`, own releases and auto-update | Merged |
| Branding | exit banner (cat + MIAO), terminal title, install script | Merged |
| Cost accounting | per-turn cost from model rates, session totals, revert-aware | Merged |
| Native-currency cost | price in the provider's own currency (e.g. DeepSeek CNY) so totals match the real bill | Merged |
| Prompt-cache telemetry | per-turn TTFT and cache hit ratio, warm / expected-rebuild / miss, optional cache TTL | Merged |
| Compaction tuning (opt-in) | cheap summarize model, hot-prefix reuse, BPE thresholds, tool-output pruning | Opt-in |
| Code Mode | tool set collapses behind one `execute` tool with a budgeted catalog | Experimental |

Status: the Rust native modules are opt-in (`MIAO_NATIVE=1`) and not wired into the default paths; the process sandbox is wired opt-in (`MIAO_SANDBOX=1`); versioning, update source, branding, and cost reporting are merged. Full comparison in [docs/miao-vs-opencode.en.md](docs/miao-vs-opencode.en.md); integration risks in [docs/rust-integration-risks.en.md](docs/rust-integration-risks.en.md).

## Built on opencode

miao is a derivative work based on [opencode](https://github.com/anomalyco/opencode), which is licensed under the MIT License. miao is not built by, endorsed by, or affiliated with the OpenCode team.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

Run `bun typecheck` from a package directory (for example `packages/miao`) before submitting changes.

## License

MIT. See [LICENSE](./LICENSE).
