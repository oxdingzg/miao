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
