<p align="center">
  <strong>Janus</strong>
</p>
<p align="center">The fastest, most model-agnostic entry point to AI coding.</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

Janus is an entry-level AI coding tool built on top of [opencode](https://github.com/anomalyco/opencode). It is designed around three goals:

- **Fastest response** — minimal startup and first-token latency, so the entry point feels instant.
- **Broadest model support** — one interface that adapts to as many models and providers as possible.
- **Entry-level** — a low-friction gateway into AI coding, with sensible defaults out of the box.

> [!NOTE]
> Janus is currently a private, pre-release project. It is not open source yet.

## Built on opencode

Janus is a derivative work based on [opencode](https://github.com/anomalyco/opencode), which is licensed under the MIT License. Janus is not built by, endorsed by, or affiliated with the OpenCode team.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

Run `bun typecheck` from a package directory (for example `packages/opencode`) before submitting changes.

## License

MIT. See [LICENSE](./LICENSE).
