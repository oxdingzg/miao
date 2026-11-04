# Acceptance record — REL-04 completion gate

Item: `REL-04`. Tree: `4a5f9a9e0f`. The shipped product is one Rust binary: the release
workflow builds `crates/miao-cli`, which starts `crates/miao-tui` in-process and drives
`crates/miao-engine`. The TypeScript tree under `packages/` is the implementation this
gate retires.

REL-04 is a gate, not a feature: it asks whether the Rust product carries every retained
capability and whether the legacy stack can be deleted. This record re-runs the Bun/Node
audit on the Rust tree and writes down, surface by surface, which Rust owner carries the
capability and what evidence exists for it. **It does not close the gate**: criterion 3
(deletion) is blocked by the v0.3.25 observation window that closes on 2026-11-16, and the
ledger below names the roadmap items that are still acknowledged gaps.

## 1. Bun/Node required-dependency audit on the product default paths

Scope is the shipped binary: default start, default tools and default session execution.
The development toolchain (`bun typecheck`, `bun test` under `packages/`), the optional
extension worker, and programs a user configures are recorded separately and are not part
of the default path. The greps ran from the repository root; the dependency graph ran
from `crates/miao-cli/` (there is no root `Cargo.toml`).

| check | command | observed |
| --- | --- | --- |
| production code spawns no JS runtime | `grep -rn 'Command::new("bun"\|Command::new("node")\|Command::new("npx")\|Command::new("deno")' crates --include=*.rs` | no hits |
| the dependency graph carries no JS engine (run in `crates/miao-cli/`) | `cargo tree -p miao-cli --prefix none \| grep -Ei 'deno\|quickjs\|boa\|javascript\|v8\|nodejs'` | no hits (1,193 lines of tree) |
| the release builds the Rust entry point | `grep -n 'crates/miao-cli' .github/workflows/release.yml` | `One artifact per platform, built from crates/miao-cli` |
| the install path asks for no JS runtime | `grep -n 'bun\|node' install` | one hit, a comment in the `--capabilities` probe; nothing is executed from it |
| the shipped binary links no JS runtime | `otool -L ~/.miao/bin/miao` | `Security`, `CoreFoundation`, `libiconv.2`, `libSystem` only |
| the shipped binary starts | `~/.miao/bin/miao --version` | `miao 0.3.30` |

Result: **accepted** — no default path requires Bun or Node.

Recorded outside the default path, and unchanged by this record:

- **Optional extension worker.** `crates/miao-engine/src/worker.rs` spawns the configured
  `argv`; the tools it contributes are labelled `[extension worker; requires external-tool
  authorization]`. Nothing is spawned when no worker is configured.
- **User-configured servers and tools.** MCP (`mcp.rs`), LSP (`lsp.rs`), PDF rendering
  (`pdf.rs`) and editors (`crates/miao-tui/src/platform/editor.rs`) run programs the user
  names, which may be `node` or `npx`; this is user configuration, not a product
  dependency.

## 2. Retained capability ledger

Each retained capability has one Rust owner. "Accepted" cites the record whose commands
ran it; "open" names the roadmap issue, so a gap is acknowledged rather than implied.

| capability | Rust owner | evidence |
| --- | --- | --- |
| Session execution, admission, retry and continuation | `crates/miao-engine/src/session_*.rs`, `runtime/` | accepted: `2026-11-01-offline.md` (VAL-03); open: RUN-01 #2116, RUN-02 #2117, RUN-05 #2119, RUN-07 #2121, RUS-02 #2104 |
| Configuration, scope and reload | `config_derive.rs`, `config_explain.rs`, `config_scope.rs` | accepted with named gaps: `2026-11-04-config-ext-retry.md`; open: CFG-02 #2107, CFG-03 #2108 |
| Permissions, approvals and sandbox | `permission*.rs`, `approval.rs`, `crates/miao-sandbox` | open: SEC-04 #2113, SEC-05 #2114 |
| Tools, editing and verification | `tools.rs`, `tools/`, `patch.rs`, `edit_recovery.rs`, `verification.rs` | accepted with named gaps: `2026-11-01-offline.md` (TOOL-05); open: TOOL-01 #1953, TOOL-02 #1954, TOOL-03 #1955, TOOL-04 #1956, TOOL-06 #1959, TOOL-07 #1960 |
| Interactive terminals, background jobs, schedules | `terminal.rs`, `jobs.rs`, `monitor.rs`, `cron.rs`, `wakeup.rs` | accepted: `2026-11-01-tui-batch.md` (JOB-02), `2026-11-01-job04.md`, `2026-11-01-tui-batch-2.md` (JOB-05); open: JOB-01 #1961, JOB-03 #1963, JOB-06 #1966 |
| Models, routes, providers and retries | `provider.rs`, `model_*.rs`, `routing.rs`, `bedrock*.rs`, `openai_*.rs`, `gemini.rs`, `copilot.rs` | accepted with named gaps: `2026-11-04-config-ext-retry.md` (MOD-05); open: MOD-01 #2126, MOD-06 #2131 |
| Context, compaction and memory | `context*.rs`, `recall.rs`, `knowledge.rs`, `recap.rs` | open: CTX-04 #1951, CTX-05 #1952 |
| Usage, cost and diagnostics | `usage.rs`, `progress.rs`, `events.rs` | accepted: `2026-11-01-offline.md` (COST-04, COST-01); open: COST-02 #1972, COST-03 #1973, COST-05 #1975 |
| Storage, migration, export and transfer | `store.rs`, `export.rs`, `transfer*.rs`, `retention.rs` | accepted: `2026-11-04-data-migration-transfer.md`; open: DATA-01 #2175, DATA-02 #2176 |
| Extensions: workers, MCP, hooks, LSP, formatter | `worker.rs`, `mcp.rs`, `hooks.rs`, `lsp.rs`, `formatter.rs` | accepted with named gaps: `2026-11-04-config-ext-retry.md`; open: EXT-01 #2156, EXT-04 #2159, EXT-05 #2160, EXT-06 #2161, EXT-07 #2162 |
| Skills, catalogue and templates | `catalog.rs`, `tool_catalog.rs`, `session_command.rs` | open: CAT-01 #2151, CAT-03 #2153, CAT-04 #2154 |
| CLI, services, HTTP API and ACP | `crates/miao-cli/src/cli.rs` | accepted: `2026-11-04-cli-entry-point.md` (RUS-04); open: CLI-02 #2164, CLI-03 #2165, RUS-06 #2106 |
| TUI input, history, streaming and themes | `crates/miao-tui/` (`input.rs`, `editor.rs`, `scroll.rs`, `markdown.rs`, `theme.rs`) | accepted: `2026-11-01-tui-batch.md`, `2026-11-01-tui-batch-2.md`, `2026-11-01-inp07.md`, `2026-11-01-ux05.md`; open: UX-01 #1990, INP-01 #1979, TUI-03 #1977, TUI-04 #1978 |
| History, snapshots and verification receipts | `history.rs`, `snapshot.rs`, `verification.rs` | accepted: `2026-11-01-offline.md` (HIS-03); open: HIS-05 #1985 |
| Media and attachments | `media.rs`, `pdf.rs`, `blob.rs` | accepted: `2026-11-01-offline.md` (MEDIA-03); open: MEDIA-01 #1987, MEDIA-02 #1988 |
| Subagents, delegation, questions and goals | `subagent.rs`, `children.rs`, `question.rs` | open: AGT-02 #1967, AGT-04 #1969, AGT-05 #1970 |
| Workspace, VCS and placement | `placement.rs`, `vcs.rs`, `crates/miao-cli/src/cli.rs` | open: WSP-01 #2147 |
| Accounts and credentials | `crates/miao-credential/` | open: AUTH-04 #2135 |
| Performance and event backpressure | `progress.rs`, `events.rs`, `crates/miao-tui/src/scroll.rs` | accepted: `2026-11-01-perf04.md`, `2026-11-01-tui-batch.md` (PERF-02); open: PERF-05 #1999 |
| Release, install and upgrade | `.github/workflows/release.yml`, `install`, `crates/miao-cli/src/cli.rs` | open: REL-01 #2181, REL-02 #2182, REL-03 #2183, REL-05 #2184 |
| Remote, web and desktop clients | `packages/remote-control`, `packages/app`, `packages/desktop` | deferred as a phase, not as a claim of completion: APP-01 #2169 – APP-05 #2173 |

The ledger's definition of "acknowledged" is the board: 73 open items besides REL-04 carry
the capabilities or criteria that have no accepted Rust replacement yet. None of them is
implied to pass by this record.

## 3. Deleting the TypeScript TUI, runner and host

**Not accepted, blocked.** The deletion gate is the observation window for candidate
`v0.3.25`, opened 2026-11-02 and planned to close 2026-11-16
(`specs/rust-retirement-gates.md`). At this tree the window is still open, so no deletion
PR is authorised: the order in `specs/rus02-ts-runner-retirement.md` is (1) move the
remaining CI sandbox exercise off the TS entry point, (2) delete the TS product entry and
assembly, (3) delete `runner/` with its two remaining edges. Step 1 landed as #2493; steps
2 and 3 wait for the window and for RUS-02 (#2104), which is still in progress.

## 4. Linked work

- `specs/rust-retirement-gates.md` — G1–G8 evidence, the Bun/Node audit of the retired TS
  artifact, and the observation window.
- `specs/rus02-ts-runner-retirement.md` — the per-file inventory of what still couples the
  TS stack.
- `docs/acceptance/README.md` — index of every record cited above.
- #2493 — first step of the deletion order (CI sandbox exercise moved to `miao-run`).

Still unaccepted after this record: criterion 3, and every capability row marked "open".
