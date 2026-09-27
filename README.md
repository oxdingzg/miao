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

miao is a fork of opencode, so the baseline below is opencode's TS implementation, measured on the same machine (release, medians). Higher is better.

| Item | opencode (TS) | miao (Rust native) | Speedup |
|---|---|---|---|
| edit exact match (12k lines) | 0.21 ms | 0.12 ms | 1.7x |
| edit fuzzy match (12k lines) | 0.76 ms | 0.39 ms | 1.9x |
| edit match + diff stats (12k lines) | 2.03 ms | 1.78 ms | 1.14x |
| apply_patch exact (20k lines) | 1.67 ms | 1.28 ms | 1.3x |
| apply_patch trim match (20k lines) | 3.47 ms | 1.76 ms | 2.0x |
| apply_patch unicode-normalize (20k lines) | 13.06 ms | 5.21 ms | 2.5x |
| git status, small repo (10 files) | 12.3 ms | 1.0 ms | 11.9x |
| git status, large repo (2200 files) | 13.6 ms | 5.8 ms | 2.4x |

Beyond speed:

- **Kernel-level sandbox** (macOS seatbelt): writes limited to the workdir, network denied by default, blocked paths reported and retried after a prompt. Rule-based permissions cannot enforce this.
- **gix in-process git status**: no subprocess spawn.
- **Independent versioning and update source** (`oxdingzg/miao`, starting at `0.0.1`).

Status: the native modules and sandbox are proof-of-concept and not wired into production; versioning, update source, and branding are merged. Full comparison in [docs/miao-vs-opencode.en.md](docs/miao-vs-opencode.en.md); integration risks in [docs/rust-integration-risks.en.md](docs/rust-integration-risks.en.md).

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
