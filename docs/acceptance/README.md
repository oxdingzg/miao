# Acceptance records

An acceptance record answers one question: **can someone else reproduce the claim?**
It is not a status note, and it does not depend on a release existing.

## What a record contains

- **Item** — the roadmap code, e.g. `COST-04`.
- **Criterion** — one acceptance bullet, quoted, not paraphrased into something easier.
- **Command** — the exact command a reviewer runs, with any environment it needs.
- **Observed** — what that command printed, from a recorded run.
- **Tree** — the commit the run was made on.

## The two kinds of criterion

1. **Behaviour with a test behind it.** The command is the test; the record cites the
   suite and the count. A criterion with no test is not accepted by this record — it
   is named as unaccepted and why.
2. **Measurement.** The command is the harness; the record carries the numbers it
   printed, including the ones that miss a gate. A missed gate is recorded as missed.

## What "done" means here

An item is **accepted offline** when every criterion has a run that passes on the
recorded tree. The repository convention still adds `roadmap: CODE done in vX.Y.Z`
only when a release ships that tree, so an accepted item waits for the release stamp
and nothing else. Until then the record is the evidence, and an item with one
unaccepted criterion stays open.

Records are written per date, not per item, because one run produces the evidence for
several items at once.

## Index

One line per record: the tree its commands ran on, and the items it covers. A
record is the evidence for its own tree; when an item gains evidence later, the
newer record is the one to read.

| record | tree | items |
| --- | --- | --- |
| `2026-11-01-offline.md` | `acc8468d42` | VAL-03, PERF-01, PERF-03, INP-06, COST-04, CFG-01, COST-01, MEDIA-03, HIS-03, INP-03, TOOL-05 |
| `2026-11-01-tui-batch.md` | `a6b6501727` | UX-02, JOB-02, PERF-02 |
| `2026-11-01-tui-batch-2.md` | `e76064e87c` | JOB-05, UX-03 |
| `2026-11-01-inp07.md` | `b2e113d838` | INP-07 |
| `2026-11-01-ux05.md` | `9c64321659` | UX-05 |
| `2026-11-01-job04.md` | `a592266307` | JOB-04 |
| `2026-11-01-perf04.md` | `2cc8d13342` | PERF-04 (and a re-verification of every command the earlier records cite) |
| `2026-11-01-inp05.md` | `bc4dc86fcc` | INP-05 |
| `2026-11-04-config-ext-retry.md` | `04dc191a01` | CFG-02, CFG-03, MOD-05, EXT-01, EXT-04, EXT-05, EXT-06, EXT-07 |
| `2026-11-04-data-migration-transfer.md` | `04dc191a01` | DATA-01, DATA-02 |
| `2026-11-04-cli-entry-point.md` | `04dc191a01` and `2c35372277` | RUS-04 |
| `2026-11-05-ux04-terminal-restore.md` | `9d8ac06104` | UX-04 (restore on panic/exit/suspend, title toggle and payload safety; clearing redraws and the tmux/SSH/Windows matrix stay open) |
| `2026-11-05-tool02-versioned-edits.md` | `80c316cad3` | TOOL-02 (fingerprint refusal and anchored rebase, whole-or-nothing patches, BOM/EOL preservation; renames, large files and edit Unicode stay open) |
| `2026-11-05-cost05-doctor-report.md` | `d13b75a3ee` | COST-05 (doctor reports version, routing, sandbox mode in effect and each external program; log export and tracing overhead stay open) |
| `2026-11-05-his03-undo-and-snapshots.md` | `9b3aca3eb1` | HIS-03 (stage/clear/commit with undo and redo, history-only vs file rollback boundaries, outside-modification preview; the shell-side-effect disclaimer stays open) |
| `2026-11-05-rel04-completion-gate.md` | `4a5f9a9e0f` | REL-04 (audit and capability ledger; deletion blocked by the observation window) |
| `2026-11-05-val03-review-changes.md` | `a1239dff43` | VAL-03 (the reviewing-changes row `2026-11-01-offline.md` left unaccepted) |
| `2026-11-05-tool04-diagnostics-version.md` | `097e6717ee` | TOOL-04 (versions and staleness in the diagnostics payload, and the completion check's repair path) |
| `2026-11-05-tool05-output-budgets.md` | `9b3aca3eb1` | TOOL-05 (size/timeout/long-line bounds per tool family, bounded previews with handle retrieval, oversized payload externalization; a runaway-command case stays untested) |
| `2026-11-05-job02-background-tasks.md` | `db0b250ae6` | JOB-02 (job/shell/child listing, scoped cancel and stop, crash reconciliation; a subagent-suite flake is recorded as open) |
| `2026-11-05-cfg02-managed-scope.md` | `db0b250ae6` | CFG-02 (the managed scope: platform paths, lowest priority, only when deployed) |
| `2026-11-05-tool01-bounded-retrieval.md` | `e943537ff2` | TOOL-01 (read windows, read batches, grep/glob filters and ignore rules; the LSP result budget and the retrieval measurement stay open) |
| `2026-11-05-cost03-cache-health.md` | `82d4e77eae` | COST-03 (recommendations for every unhealthy cache state; the TUI cache line stays open) |
| `2026-11-05-tool06-malformed-input-and-loops.md` | `e67cfe8664` | TOOL-06 (bounded correction for malformed calls, loop detection that halts before a late tool call, provider-only neutralization; the cross-provider matrix stays open) |
| `2026-11-05-tool07-web.md` | `37db1dc9c3` | TOOL-07 (source URL, body bound, redirects, credentials, cancellation) |
| `2026-11-05-cfg02-unknown-keys.md` | `82d4e77eae` | CFG-02 (unknown keys warned about with their source and closest known key; the managed scope stays open) |
| `2026-11-07-val02-task-accounting.md` | `97b4dea0ce` | VAL-02 (per-completed-task cost, submit-to-verified-completion wall clock, human-intervention accounting; a real-model intervention round stays open) |
| `2026-11-07-wsp01-workspace-surfaces.md` | `c922187e2a` | WSP-01 (project discovery and naming, worktree list/create/move/remove, the workspace list and the CLI adapter; the workspace-create success path and Windows placement stay open) |
| `2026-11-07-cost04-turn-timings.md` | `18b3a92cc3` | COST-04 (all three criteria, re-run on a current tree; the `turn_timings` filter the issue cites matches no test since the phase-ledger rename) |
| `2026-11-07-ux04-clear-redraw.md` | `3dbf1529ae` | UX-04 (a requested redraw clears via the backend's Clear-All by resizing the fullscreen viewport, pinned against a captured backend; panic restore, suspension hooks, title toggle, and real-terminal validation stay open) |
| `2026-11-07-tui04-render-fallbacks.md` | `6e82464349` | TUI-04 (narrow-width markdown, media, and folded-output rendering pinned; unknown content passes through character for character; image results name the media and never paint its bytes; the real-client visual pass stays open) |
| `2026-11-07-job03-declarative-parallel.md` | `52d0fdb929` | JOB-03 (declarative read parallelism pinned end to end, conflicting writes serialized in request order, and an overlap receipt reporting admitted count, declared bound, and observed peak in-flight; the wall-clock benchmark and cost totals stay open on VAL-04) |
| `2026-11-09-inp03-paste-payloads.md` | `410c411d03` | INP-03 (folded pastes, pasted file references, and named byte-exact attachments admitted with the prompt end to end; same-size paste markers made 1:1 with their payloads; Windows clipboard retry semantics pinned on the injectable harness; real Windows clipboard access and the live-client pass stay open) |
| `2026-11-09-ux01-themes-and-preferences.md` | `db3059519d` | UX-01 (the TypeScript host's 34 theme assets carried verbatim and resolved under the operator's pinned mode, custom overlays in place, the mode lock persisted through restarts with tests pinning dual-mode resolution and the reload recolour; terminal auto-detection and the real-client visual pass stay open) |
| `2026-11-09-inp03-paste-attachments.md` | `da2bb188fb` | INP-03 (paste markers, file references, and attachment payloads hold end to end with bracketed-paste folding, PDF/named attachment, and Windows clipboard retry pins; real-client flows across terminal emulators stay open) |
| `2026-11-09-agt05-peer-receipts-budget.md` | `dcfccbd481` | AGT-05 (typed PeerReceipt with durable sender/reply_to attribution and same-project identity at the store boundary, exact reply linkage replacing prompt-prefix matching, durable refusal events with stop reasons, legacy-thread fallbacks; TUI/CLI thread view and budget configuration stay open) |
| `2026-11-09-perf04-idle-profile.md` | `3abbf283` | PERF-04 (a whole-process-tree sampler profiles idle CPU and RSS with convergence checks and named thresholds; longer soaks and cross-platform sampling stay open) |
| `2026-11-09-job02-jobs-dialog.md` | `bd8705dc4d` | JOB-02 (the jobs answer composes owners, output, and the subagent side list; stop-all runs behind a destructive confirm; a reopened dialog renders the engine's true state after restart — wire + dialog + PTY pins; live-client stop flows stay open) |
| `2026-11-09-job05-schedule-editing.md` | `4cdbf8339b` | JOB-05 (cron and wakeup schedules edit in place through a cron.updated overlay every reader applies; restart adoption re-arms the edited definition; recurring occurrences admit distinct inputs — edit/adopt pins in cron and wakeup suites; the TUI editing surface and per-task budget accounting stay open) |
| `2026-11-09-job02-jobs-dialog.md` | `bd8705dc4d` | JOB-02 (the jobs answer composes owners, output, and the subagent side list; stop-all runs behind a destructive confirm; a reopened dialog renders the engine's true state after restart — wire + dialog + PTY pins; live-client stop flows stay open) |
| `2026-11-09-job05-schedule-editing.md` | `4cdbf8339b` | JOB-05 (cron and wakeup schedules edit in place through a cron.updated overlay every reader applies; restart adoption re-arms the edited definition; recurring occurrences admit distinct inputs — edit/adopt pins in cron and wakeup suites; the TUI editing surface and per-task budget accounting stay open) |
| `2026-11-09-ux02-keyboard-selection.md` | `9cdbd5ca7a` | UX-02 (keyboard-only reachability re-evidenced by the two guards, double-click word selection with the gap and stale-window refusals, `focus_reporting` joined to the terminal knobs, and the wheel moved through the open dialog the docs always claimed; word runs across wraps, composer double-click, dialog wheel acceleration, and the real-terminal matrix stay open) |
| `2026-11-09-tool06-malformed-args-loops.md` | `f08ba210ce` | TOOL-06 (unknown tools and wrong-typed arguments settle corrective results that name the fix, an oversized argument payload pauses the drain instead of failing the run, and identical failing calls exhaust the same refusal bound as successful ones, with the repetitive-output guard and history-neutralization pins re-cited; the cross-provider matrix and real-client evidence stay open) |
| `2026-11-07-inp05-visible-context.md` | `1ba5bce210` | INP-05 (the composer-visible, removable Zed context the 2026-11-01 record rejected: deletion stays deleted, a changed selection replaces instead of stacking, a probe failure leaves the draft alone; live-Zed acceptance and the target version stay open) |
| `2026-11-07-tool01-lsp-result-budget.md` | `e4e9996cf6` | TOOL-01 (the LSP call-hierarchy bounds — item limit, call-count limit, 64 KiB result budget — and the wire's per-response cap, completing criterion 1; criterion 2 stays partial and the retrieval measurement stays open) |
| `2026-11-07-tool02-rename-large-unicode.md` | `1580c08bfe` | TOOL-02 (renames, large files and edit Unicode, closing the criteria `2026-11-05-tool02-versioned-edits.md` left open) |
| `2026-11-07-tool05-family-matrix.md` | `9f56d83eaa` | TOOL-05 (the family × budget matrix on one tree, with the new read-window suite; the 2026-11-05 runaway "not tested" paragraph is superseded by `tests/process.rs`; the web `timeout` bound stays open) |
| `2026-11-07-media01-materialization.md` | `7157d9cb01` | MEDIA-01 (capability-dependent materialization into the confined workspace with recovery, consistent capability refusal with the tool-read fallback, rejection of unsupported/oversized/mislabelled/count-over media before durable state, cancellation durability, >1 MiB stdio admission frames and in-place oversized refusal; URI resolution stays above the engine boundary and the ffmpeg-gated video workflow stays run-on-demand) |
| `2026-11-07-tui03-stream-render.md` | `e170b105ee` | TUI-03 (incremental text/reasoning/tool pins, single-replace state settling, opaque vs transparent reasoning; a live provider wire and a real-client run stay open) |
| `2026-11-07-his03-shell-disclaimer.md` | `613907dd68` | HIS-03 (the shell/external-side-effect disclaimer the 2026-11-05 record left unaccepted, now pinned on the TUI revert confirmation for history-only and file plans alike; a live-client run and the release stamp stay open) |
| `2026-11-07-tool07-mcp-search.md` | `23d725d997` | TOOL-07 (real REST/MCP backend selection with fail-closed host config, per-backend payload/turn cost bounds in each format's own vocabulary; the real-credential retrieval-quality and latency run stays open) |
| `2026-11-07-cost04-turn-timings.md` | `18b3a92cc3` | COST-04 (all three criteria, re-run on a current tree; the `turn_timings` filter the issue cites matches no test since the phase-ledger rename) || `2026-11-07-job04-backpressure-signal.md` | `c1b981f229` | JOB-04 (the backpressure edge, its depth counting without a sender `len()`, the status line's `Engine backlog · N queued` rank, and the retry-budget tests; the wider cancellation matrix and real-terminal checks stay open) |
| `2026-11-07-agt04-goal-plan-checklist.md` | `0f0cfa0283` | AGT-04 engine side (execution checklist / pending plan / persistent goal as three durable kinds, structured `goal.budget` + `stop_when`, plan persistence and fork copy, `verified` defaulting false; the TUI three-way display stays open) |
| `2026-11-10-job06-cross-session-fairness.md` | `b298679b84` | JOB-06 engine side (per-Session fair shares on the job and subagent pools, the `resources` snapshot with queue accounting, the saturated-pool control-lane pin, stress-harness numbers for queue latency, starvation, RSS, and fds from a build-host run; the release stamp stays open) |


A record that has drifted from the tree is worse than no record: `2026-11-01-perf04.md`
carries the table of filters that were re-run to keep the earlier records honest.

## When a record stops matching the code

A record is evidence for its own tree, not a promise about today's. When later work
removes the widget or test a row cites, the row is **annotated in place** rather than
deleted or silently left to look current:

> **Superseded** / **Not accepted — the claim was wrong.** …what changed, which commit
> changed it, and what remains true.

Three rows earned that treatment on 2026-11-03, found by checking every test name the
records cite against the source:

- `2026-11-01-ux-interaction-batch.md` — the list pointer rows cite
  `a_click_on_the_list` and `a_second_click_on_the_same_row`, which `#2431` removed
  along with the launcher list they drove.
- `2026-11-01-tui-batch-2.md` — an animation row argued the TUI paints no animation
  from a `grep` that returned 0 then and returns 7 now (the running-tool spinner).
- `2026-11-01-inp05.md` — a row claimed the Zed selection is visible in the composer
  and removable by editing. `App::zed_context` prepends it during `submit`, so the
  operator never sees it first.

The rule that follows: **a cited test name has to resolve**, and a claim about what the
code does has to be true of the code today. Re-verifying a record means running its
commands on the current tree, not reading its counts.
