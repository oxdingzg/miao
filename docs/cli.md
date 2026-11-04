# CLI inventory

The product is the single Rust binary (`crates/miao-cli`, command `miao`).
The TypeScript CLI under `packages/miao/src/cli/` is the compatibility path
that rides with the product database until the S4 rollback window ends; it is
not a second product surface to keep feature-parity with forever.

## Release identity

One artifact per platform is published: `miao-<os>-<arch>`, built from
`crates/miao-cli` (`--bin miao`). The engine and the TUI are linked into that
binary, so an install needs neither `miao-engine` nor `miao-tui` beside it, and
the installer writes only `miao`. The `engine-artifacts` workflow still builds
`miao-engine` archives on `engine-v*` tags for development and testing; those are
Actions artifacts, not release assets, and no product install consumes them.

Two files decide which crate is packaged — `packages/miao/script/build.ts`
(`PRODUCT`) and `.github/workflows/engine-artifacts.yml` (job `native`).
`packages/miao/test/installation/product-binary.test.ts` fails when either drifts
from this document, because a release built from the wrong crate ships a binary
that answers `--version` but not the commands listed below.

This is the RUS-04 inventory of every visible root command, with its
disposition. The two sides are compared at `main` as of 2026-11-02; the
inventory is updated when a command lands or retires.

## Dispositions

- **rust** — lives in the Rust binary; the TS twin retires with the TS CLI.
- **product-db** — the command maintains the product database (projection),
  which the engine ledger does not model. It stays TypeScript-hosted until the
  product write path retires, then retires with it; re-implementing it in Rust
  first would be work thrown away at the same deadline.
- **rust-todo** — a product command the Rust binary still owes.
- **ts-only** — plugin-ecosystem tooling around npm packages and marketplace
  manifests. Its future is decided with the plugin story (EXT-01/EXT-06), not
  by this inventory.

## Root commands

| command | TS | Rust | disposition | notes |
|---|---|---|---|---|
| (default) TUI | `$0` | `miao` / `miao tui` | rust | TUI is linked in, not spawned |
| `run` | `run [message..]` | `run [options] PROMPT` | rust | headless one-shot |
| `serve` | `serve` | `serve` | rust | resident loopback engine |
| `session` | `session` | `session list/fork/import/move/...` | rust | bundle export/import included |
| `stats` | `stats` | `stats [--json] [--engine]` | rust | |
| `acp` | `acp` | `acp` | rust | Agent Client Protocol over stdio |
| `agent` | `agent` | `agent list` | rust | |
| `attach` | `attach <url>` | `attach URL` | rust | |
| `auth` | `auth login/logout [provider]` | `auth login/logout/list INTEGRATION` | rust | |
| `db` | `db ...` | `db path/stats/vacuum/retention` | see below | |
| `debug` | `debug <name>` | `debug paths/info/mcp/lsp/routes` | rust | read-only diagnostics |
| `doctor` | `doctor` | `doctor` | rust | engine diagnostics |
| `export` | `export [sessionID]` | `export SESSION` | rust | committed events as JSONL |
| `import` | `import <file>` | `session import BUNDLE` | rust | same operation, Rust spelling |
| `mcp` | `mcp` | — | rust-todo | connection management surface |
| `memory` | `memory [id]` | `memory` | rust | workspace knowledge store |
| `models` | `models [provider]` | `models` | rust | |
| `providers` | `providers` | `providers` | rust | routes + credentials, types only |
| `remote` | `remote` | `remote` | rust | pairing state |
| `report` | `report` | `report TO TEXT` | rust | |
| `pr` | `pr <number>` | `pr [NUMBER]` | rust | |
| `upgrade` | `upgrade [target]` | `upgrade` | rust | |
| `uninstall` | `uninstall` | `uninstall` | rust | dry-run default; #2356 |
| `web` | `web` | `web` | rust | |
| `completion` | — | `completion SHELL` | rust | Rust-side addition |
| `hub` / `hubctl` | — | `hub` / `hubctl OP` | rust | Rust-side addition |
| `worktree` | — | `worktree add/list/remove` | rust | Rust-side addition |
| `workflow` | — | `workflow run/script` | rust | Rust-side addition |
| `plugin` | `plugin <module>` | — | ts-only | npm plugin install |
| `marketplace` | `marketplace <source>` | — | ts-only | marketplace browse/install |
| `generate` | `generate` | — | ts-only | config scaffolding |
| `runtime` / `runtime-access` | `runtime <action>` | — | ts-only | hidden; host-side plumbing |

## Management commands (CLI-06)

| command | TS | Rust | disposition |
|---|---|---|---|
| `auth` | `auth login/logout [provider]` | `auth login/logout/list` | rust |
| `config` | `debug config` | — | rust-todo; `miao-engine config explain` already carries the resolution, the CLI surface forwards to it |
| `models` | `models [provider]` | `models` | rust |
| `agent` | `agent` | `agent list` | rust |
| `mcp` | `mcp` | — | rust-todo; the connection-management surface (EXT-03's home) |
| `skill` | `debug skill` | — | ts-only; the skill catalogue is a TS plugin-layer surface (CAT-04) |
| `db` | `db ...` | `db path/stats/vacuum/retention` | rust; see the table below |
| `doctor` | `doctor` | `doctor` | rust; engine-side WAL/FK/transfer matrix included |
| `remote` | `remote` | `remote` | rust |
| `runtime` | `runtime <action>` | — | ts-only; host-side plumbing |
| `install` | — | — | n/a; the curl installer, not a CLI command |
| `upgrade` | `upgrade [target]` | `upgrade` | rust |

## `db` subcommands

| subcommand | TS | Rust | disposition |
|---|---|---|---|
| `path` | yes | yes | rust; Rust prints engine ledger + product database |
| `stats` | yes | yes | rust |
| `vacuum` | yes | yes | rust; dry run unless `--apply` |
| `retention` | yes (plan only) | yes (plan; engine-side snapshot-then-truncate) | rust; the CLI reports, `miao-engine retention --apply` truncates (DATA-04) |
| `backfill` | yes | — | product-db |
| `compact` | yes | — | product-db |
| `restore` | yes | — | product-db |
| `externalize-blobs` | yes | — | product-db |
| `gc-blobs` | yes | — | rust-todo for the ledger's own orphans; product-db for blob files |

## Environment variables

| variable | meaning | read by |
|---|---|---|
| `MIAO_ENGINE_STORAGE` | engine ledger storage root | Rust (placement) |
| `MIAO_ENGINE_DB` | explicit engine ledger | Rust (TUI start) |
| `MIAO_DATA_HOME` / `XDG_DATA_HOME` | product data root (`miao.db`, credentials) | Rust + TS |
| `MIAO_CONFIG_DIR` | configuration directory | Rust + TS |
| `MIAO_PRODUCT_DATABASE` | explicit product database | TS host |
| `MIAO_ENGINE_CREDENTIAL_DB` | explicit credential database | Rust |
| `MIAO_DB` | product database override | TS |

## Exit codes

The Rust binary exits `0` on success, `1` on an operational error, and `2` on
a usage error (unknown command or missing argument), printed to stderr with
the failing command as prefix.

## Licence compliance

The binary redistributes every crate in its dependency graph, so the licence of
each one decides what the product can be shipped as. miao is MIT, and a
derivative of opencode under the MIT grant, so the graph has to stay
permissive-only.

```sh
cd crates/miao-cli
cargo deny check licenses
```

`crates/miao-cli/deny.toml` holds the allow-list and the reason for the two
entries that are not self-evident: `MIT-0` is MIT without the attribution
requirement, and `CDLA-Permissive-2.0` covers the Mozilla root-certificate data
crates. The `cli` CI job runs the same command, so a new dependency with an
incompatible licence fails the pull request that adds it rather than the release
that ships it.
