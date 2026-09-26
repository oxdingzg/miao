# Feasibility of Rewriting miao in Rust

**Language:** [English](rust-rewrite-feasibility.en.md) | [中文](rust-rewrite-feasibility.zh.md)

## Verdict up front

**A full Rust rewrite is not feasible today. A protocol-first, incremental "native core" approach is feasible.**

The sections below are grounded in the actual repository: file counts, line counts, dependency surface, and where native bindings already exist.

## 1. What miao actually is

Non-test TS/TSX totals **2,474 files / ~495k lines**, but most of it is not the "engine":

| Area | Size | Worth / needs a Rust rewrite |
|---|---|---|
| Engine: `miao + core + tui + llm + server + schema + protocol + client + plugin` | ~176k lines | This is the rewrite target |
| `packages/app` (Solid/Vite), `ui`, `console`, `stats`, `web/docs` | ~300k lines | Frontend; Rust is meaningless here |
| `desktop` (Electron) | 124 files | Keep |
| Tests | miao 300 + core 160 + tui 53 files | Must be rewritten / rerun |

Engine-side key numbers: `miao/src` has 98 runtime dependencies, **528 files import `effect`**, 25 tools, 26 CLI commands, 21 HttpApi groups.

## 2. Why a full rewrite is hard

1. **The architectural backbone is Effect v4 beta** (Layer/DI, Fibers, Stream, Schema, structured concurrency). Rust only has tokio + serde, so you would first have to re-architect an entire concurrency + DI + Schema framework. That is not translation, it is redesign.
2. **The AI SDK ecosystem is JS-exclusive**: 19 `@ai-sdk/*` providers plus openrouter/gateway/gitlab/venice. On the Rust side you would reimplement streaming tool-calls, reasoning fields, images, usage, OAuth device code, etc. This is the heaviest and most likely to lag part of the project.
3. **The TUI is a bespoke renderer** (`@opentui/core` + `@opentui/solid`) with shimmer animations and a plugin API; switching to ratatui loses fidelity and plugin compatibility.
4. **The plugin system executes user TS/JS**, so a Rust host still needs an embedded JS runtime (deno_core/quickjs) or must keep Node.
5. **Native/WASM dependencies**: node-pty, @parcel/watcher, tree-sitter (bash/powershell), photon, zip.js, drizzle/sqlite, MCP/LSP/ACP.
6. **Bun compilation already ships a single-file binary** (with embedded Web UI and tree-sitter worker) — the distribution win from Rust is far smaller than expected.

## 3. What Rust actually buys

- **Memory**: clearly lower (Bun/Node resident memory is often tens to hundreds of MB).
- **CPU / startup**: limited for an "AI coding tool" — the bottleneck is model network latency, not local CPU. Bun startup is already fast.
- **Safety sandbox / concurrency**: for PTY, subprocess supervision, and file indexing, Rust is genuinely more solid.

In other words: **the gains are concentrated in a few performance/memory-sensitive modules, not global.**

## 4. Rough cost

The engine is ~176k lines of TS. Accounting for re-implementing the framework + providers + TUI, the Rust side would likely be **150k–250k lines**, reaching functional parity in roughly **6–18 engineer-months** (excluding web/desktop/docs and the plugin ecosystem), with providers/TUI continuously in catch-up. The risk/benefit ratio is poor.

## 5. Recommended path (in order of preference)

1. **Stay TS-first** unless there is a concrete memory/sandbox hard requirement.
2. **Incremental native**: rewrite only hot paths with clear boundaries in Rust via `napi-rs`/Bun FFI — ripgrep-style search index, diff/merge, tree-sitter parsing, git, PTY/sandbox supervision, SQLite index. Leave the rest alone. This is the most easily replaceable layer in `packages/miao/src/tool/*`.
3. **Protocol-first long term**: you already have a clean `Schema → Protocol → Server` layering with HttpApi/SSE. Define a **versioned core protocol**, then incrementally build a Rust "headless engine" that speaks the same protocol, shrinking the TS shell over time. This is the only realistic path to a full-Rust miao, but it starts with the protocol, not the language.

**Judgment**: full rewrite = not recommended (high risk, long, loses ecosystem); incremental native + protocol-first = feasible and recommended.

## 6. Engine breakdown ranked by Rust benefit

Ranking is by **net benefit** (performance/memory/strategic value − migration cost/ecosystem loss). One precondition drives the ranking:

> Many hot paths in the engine **already have native bindings**: search uses `@ff-labs/fff-*`, file watching uses `@parcel/watcher`, PTY uses `node-pty`, images use `photon-node`, SQLite uses `bun:sqlite`. So Rust's incremental benefit only remains where "native bindings don't cover it / JS is CPU-bound / a sandbox is needed"; everything else is IO or ecosystem-bound with near-zero benefit.

| Rank | Module | Location | ~Size | Net benefit | Cost | One-line reason |
|---|---|---|---|---|---|---|
| 1 | **Text processing**: diff / patch / apply / edit / format | `core/tool/{edit,apply-patch}`, `miao/src/format`, `miao/tool/{edit,apply_patch}`, `session/revert-diff` | 4–6k | ★★★★★ | Low | Pure CPU text algorithms, ecosystem-free; Rust diff/patch crates are faster and leaner |
| 2 | **PTY / subprocess / sandbox** | `core/pty`, `AppProcess`, `miao/tool/{shell,bash}`, `miao/effect` | 1–2k | ★★★★★ | Low–Med | `portable-pty` + seccomp/landlock sandbox is a **unique strategic value** JS cannot match |
| 3 | **File search / walk / ignore** | `core/filesystem/{search,ignore,watcher,fff}`, `core/tool/{grep,glob,read}`, `miao/tool/{grep,glob,read}` | 2–3k | ★★★★☆ | Low | One stack of ripgrep+ignore+globset; but fff is already native, so the delta depends on its coverage |
| 4 | **Git / worktree / snapshot** | `core/git.ts`, `worktree`, `snapshot` | 1–2k | ★★★★☆ | Med | `gix` clearly beats the JS layer on large repos / high-frequency diffs; text-heavy like #1 |
| 5 | **SQLite storage / migrations / retrieval** | `core/database`, `core/session`, `miao/session`, `storage` | ~14k | ★★★☆☆ | High | `rusqlite/sqlx` is strong, but the schema is bound to Effect-Schema/Drizzle; data-model rewrite is costly |
| 6 | **tree-sitter parsing** | `core/tool/bash.ts`, `miao/tool/shell.ts` | <1k | ★★★☆☆ | Low | Native tree-sitter removes WASM overhead; small scope |
| 7 | **Token counting / model index** | `llm/src`, model data | <1k | ★★☆☆☆ | Low | `tokenizers` crate is faster; small impact on total latency |
| 8 | **Image processing** | `image`, `photon` | <1k | ★★☆☆☆ | Low | `image` crate; very narrow usage |
| 9 | **Permissions / wildcard matching** | `permission`, `minimatch` | <1k | ★★☆☆☆ | Low | Rule matching can be native; small |
| 10 | **Server / HttpApi / SSE / routing** | `miao/server`, `server`, `protocol`, `client` | ~13k | ★☆☆☆☆ | High | Network IO dominates; Effect HttpApi is highly productive; Rust only wins memory |
| 11 | **MCP / ACP / LSP transport** | `miao/{mcp,acp,lsp}` | ~11k | ★☆☆☆☆ | Med | JSON-RPC IO; bottleneck is the external process |
| 12 | **Config / project / account / auth** | `config`, `project`, `account`, `oauth` | ~8k | ★☆☆☆☆ | Med | IO + ecosystem-bound |
| 13 | **Provider & model protocol** | `llm/protocols`, `miao/provider`, `core/github-copilot` | ~19k | **≤0** | Very high | 19 AI SDK providers are a JS-ecosystem monopoly; rewriting means permanent catch-up |
| 14 | **TUI rendering** | `tui` | ~28k | **≈0.5** | Very high | Tightly coupled to OpenTUI/Solid + shimmer animation; loses visual fidelity and plugin API |
| 15 | **Plugin host / SDK / codemode** | `plugin`, `core/plugin`, `miao/plugin`, `codemode` | ~16k | **<0** | Very high | Must execute user JS/TS; a Rust host still needs an embedded JS runtime |
| 16 | **Effect runtime / DI / observability / CLI framework** | `core/effect`, `miao/effect`, `miao/cli`, `core/config` | ~30k | **0 (backbone)** | Very high | Porting it alone yields nothing; only a full rewrite touches it |

## 7. Three layers

**Layer 1 — Rust genuinely belongs here (P0, ~8–13k lines, ecosystem-free, clean boundaries)**
- Text: diff / patch / edit / format
- Process: PTY / subprocess / sandbox
- Search: grep / glob / ignore / walk
- Git: repo read/write / worktree / snapshot

These four are the **only blocks with positive net benefit that can stand alone as a library**. They barely depend on Effect, the AI SDK, or the UI, so they are the best fit for an `miao-native` crate connected back via napi-rs / Bun FFI.

**Layer 2 — decide based on metrics (P1, ~16k lines)**
- SQLite session storage / migrations / retrieval (has benefit, but rewriting the data model is risky)
- tree-sitter, token counting, images

Only touch these when you are clearly bottlenecked on memory/large-repo performance, and prefer a **read-only index** over replacing the whole storage layer.

**Layer 3 — do not touch (P2/P3, 70%+ of engine code)**
- Server/HttpApi/SSE/routing, MCP/ACP/LSP, config/account/auth
- Provider/AI SDK, TUI, plugin host, Effect backbone

These are either network IO (Rust gains nothing), a JS-ecosystem monopoly (rewrite = negative benefit), or tightly framework-coupled (prohibitive cost). **Almost all of the "not worth it" in a full Rust rewrite comes from this layer.**

## 8. Conclusion

- Inside the engine, **only the four Layer-1 modules have positive net benefit**; ranked by benefit: **text processing > process/sandbox > search > git**.
- A full rewrite is not feasible not because Layer 1 is hard, but because ~70% of the code in Layers 2–3 yields no benefit in Rust and loses the ecosystem.
- Realistic action: extract Layer 1 into a Rust native library (napi-rs/FFI or sidecar) and keep the rest in TS. That is the best return on investment.

If desired, the next step is to pin Layer 1 down to "specific files → suggested crate → interface shape (FFI/napi/sidecar) → estimated lines" as an executable PoC checklist.
