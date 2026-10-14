# Live evaluation and rollback (M4 gate evidence)

The M4 gate requires that live-eval quality is not below the baseline and that a
rollback drill passes before any default switch (ADR-08). This records the
engine-side evidence; the switch decision itself is a human gate.

## Method

- **Objective tasks with a programmatic oracle**, not free-text grading:
  create a file with exact content; edit one field while preserving another;
  fix source so a runner (`sh test.sh`) passes; run a command with a side effect;
  locate a bug across files and fix it. Anti-cheat: the test/check file's hash is
  unchanged, or the task fails.
- **Same model and workspace per comparison**, a fresh copy per run, one engine
  per run. Model: `openai/gpt-6.1-sol` (subscription Responses).
- Deterministic fixture providers are used for the unit/integration suites; the
  live eval here uses the real model.

## Result

Two sweeps, real model, engine vs the TypeScript runtime on the same tasks:

| Sweep                                                       | Rust engine             | TypeScript              |
| ----------------------------------------------------------- | ----------------------- | ----------------------- |
| 6 tasks × N=8 (create/edit/fix-test/run/grep-fix/multifile) | 48/48                   | 47/48                   |
| 3 tasks × N=3 (fix_math / fix_config / fix_offbyone)        | 9/9, p50 22 s, p95 27 s | 9/9, p50 26 s, p95 29 s |

Conclusion for the gate: on this class of objective coding tasks the engine's
success rate is **not below** the TypeScript baseline, with comparable (here
slightly lower) latency. This is **not** a full product-quality evaluation: it
covers small, objectively gradable fixes, not long-horizon or subjective work,
and the samples are small.

## Rollback drill

The local install keeps the previous binary for a one-step rollback:

- `script/install-engine.sh --binary <path>` installs a versioned binary and
  repoints `~/.local/bin/miao-engine`, keeping the previous install at
  `~/.local/share/miao-engine/bin/miao-engine.prev`.
- Drill: install build A, install build B, confirm `miao-engine --version`
  reports B, then `ln -sfn ~/.local/share/miao-engine/bin/miao-engine.prev
~/.local/bin/miao-engine` and confirm it reports A again.
- The release-managed `miao` is never touched; the engine preview is a separate
  channel (ADR-08).

## What is still required before a default switch

- A larger, more representative live-eval (more tasks, more runs, failure-reason
  distribution), and a product-level evaluation once the TUI facade is wired.
- The capability matrix cleared or a documented acceptance of replacements.
- A rollback drill executed on the shipping channel, not only the preview.

## Frozen eleven-task fixture contract

`packages/miao/src/engine/baseline.ts` defines an explicit versioned suite with
UTF-8 fixture contents, prompts, immutable oracle/config files, edit allowlists,
and suite/task SHA-256 fingerprints. Every attempt initializes a fresh directory;
existing workspaces are never overwritten. The eleven classes are read-only
navigation, small edit, multi-file repair, failing-test repair, permission denial,
tool-error recovery, interrupted-turn recovery, long-session delivery,
multi-line edit, typed repair, and large-file repair. The long-session task carries four follow-ups
that continue the same Session after each earlier input settles, so accumulated
history and the queue boundary are part of the measured run; the oracle still
checks only the final artifact and the final answer. Suite version 3 adds the
multi-line edit (a multi-line source with unique anchors, the drift-injection
carrier for the A2 evaluation) and typed repair (a runtime-correct module with a
type-consistency oracle, the carrier for the A7 post-edit diagnostics
evaluation). Suite version 4 adds large-file repair, a
deterministic source bigger than the whole-file read bound whose bug can only be
repaired through a line-window read (the pre-window engine cannot obtain the
file's fingerprint at all). Version 1 through 3 samples are foreign to this
contract and must not be paired with it.

The artifact verifier checks immutable files, unexpected files/symlinks, expected
outputs, and real workspace test subprocess exit codes. It refuses to execute a
tampered test oracle. The interruption fixture appends a marker, so repeated
completed effects produce an observable failing artifact instead of being hidden
by an idempotent overwrite.

Artifact success is not an execution or quality verdict. The verifier always
returns `executionVerdict: "unverified"`; the comparison runner supplies the
missing evidence: durable receipts, the terminal outcome, answer checks, the
effective model/agent/permission/tool-surface fingerprints, every provider
attempt's usage, and wall-clock phase samples. In particular, unchanged
protected files alone do not prove a permission denial, and an audit marker
alone does not prove stream recovery: those verdicts require the engine's
`permission_denied`/`provider.interrupted` events or the TypeScript blackbox's
cancelled provider interaction.

## Comparison runner

`packages/miao/src/engine/baseline-run.ts` executes one frozen task against one
engine and returns a report sample bound to its evidence. The Rust path drives
`miao-engine serve` over stdio, requires the policy to deny writes under
`protected/`, and reads per-attempt usage, provider-request profiles, receipts,
and recording-time phases from durable events. The TypeScript path runs the
checkout's own `miao run --format json` headlessly with an isolated database,
config, and blackbox recording; usage, profiles, and interruption evidence come
from that recording, while receipts come from the settled part stream.

The interrupted-turn task cancels through the host once the action command has
settled and a new provider stream starts, so the receipt proves host-initiated
cancellation rather than a scripted outcome. Runs without a terminal outcome, a
single effective profile, or at least one provider attempt are rejected with an
explicit reason instead of being reported as failed samples.

Sweeps run from `packages/miao` (one engine per invocation):

```sh
bun src/engine/baseline-sweep-cli.ts --engine rust --out /tmp/baseline \
  --binary ~/.local/bin/miao-engine --revision <40-hex source revision> \
  --model openai/gpt-6.1-sol --provider subscription-responses \
  --credential-db ~/.local/share/miao/miao.db --credential-id <id> \
  --credential-integration openai --repetitions 8

bun src/engine/baseline-phases-cli.ts /tmp/baseline/evidence
```

The oracle calibration tests run from `packages/miao`:

```sh
bun test test/engine/baseline.test.ts
```

They prove that the initial defective programs fail, repaired programs pass,
immutable-oracle tampering cannot bypass verification, repeated mutation fails,
and caller-modified task metadata cannot change the frozen contract. These are
fixture/oracle checks, not live-agent measurements or evidence for default-engine
promotion.

## Native failure trace sensitivity

Native host capture retains the full `provider.failed` data through the declared
identity-only projection. Failure messages, attempt/step fields, routing details,
and unknown fields remain significant; a changed failure cause must fail strict
replay. Native timestamps retain their existing recording provenance.

Older bundles that reduced failure data to `{ "failed": true }` have already lost
the original cause and must be re-recorded for diagnostic-sensitive replay. The
replayer does not invent those fields or fall back to live IO. Credential header
exclusion remains at the HTTP capture boundary.

## Comparable baseline reports

`packages/miao/src/engine/baseline-report.ts` validates sample provenance against
the frozen suite/task fingerprints and requires source revision, artifact and
receipt digests, effective model/agent/permission/tool-surface fingerprints, and
per-attempt accounting. Pairing uses task plus repetition, not array order.
Duplicate samples, missing provenance, invalid metrics, and foreign fixtures are
rejected. Every task must have balanced verified engine pairs with identical
effective profiles before the report is marked full-suite comparable.

Totals include unsuccessful attempts before recovery and failed runs. Missing
token usage or prices keep the affected totals unknown (`null`), rather than
contributing zero. Latency p50/p95 covers every run, including failures.
Successful-run attempt tokens are shown separately and never replace all-run
totals. Sample receipt digests bind the report to external execution evidence;
the summary does not manufacture those receipts or grade an agent's own claims.

From `packages/miao`, summarize collected samples with:

```sh
bun src/engine/baseline-report-cli.ts /path/to/samples.json
```

The CLI emits JSON and returns a nonzero status for incomplete/non-comparable
coverage. A comparable report still returns `defaultSwitchEligible: false`:
actual-client, ownership, common-history, installation, and rollback gates remain
independent. This reporting layer contains no live model score until genuine
collected samples are supplied.

## Recorded baseline (2026-10-14)

First full baseline on the frozen seven-task suite: eight repetitions per task
per engine, one engine per sweep, `openai/gpt-6.1-sol` over the subscription
Responses route, a fresh workspace and the workspace-write policy per run, and
the frozen oracle as the only pass criterion. Failed runs stay in the record.

- Rust: a release build of `miao-engine` from
  `985b0da05648d574e3f73091994ed1b62001eea8` (binary sha256
  `22ae83ba536160bb00a324e9e463d836fbd5574bb207cb022ae94e0526d6a858`), driven
  with `--provider subscription-responses`.
- TypeScript: the checkout at `993184bfb158b809189b2baa87b7d70ae76743d4`, run
  as `miao run --format json` in an isolated XDG data directory that inherits
  the stable credential table read-only, with a `MIAO_BLACKBOX_RECORD` bundle
  per run.

| task                | Rust        | TS   | Rust p50 | TS p50 | Rust attempts / tokens (in/out) | TS attempts / tokens (in/out) |
| ------------------- | ----------- | ---- | -------- | ------ | -------------------------------- | ------------------------------ |
| read-only           | 8/8         | 8/8  | 13.3 s   | 17.0 s | 40 / 98.3k / 1.2k                | 40 / 379.3k / 1.3k             |
| small-edit          | 8/8         | 8/8  | 15.4 s   | 23.0 s | 44 / 118.3k / 2.3k               | 50 / 477.5k / 2.4k             |
| multi-file          | 8/8         | 8/8  | 22.9 s   | 22.3 s | 48 / 141.4k / 4.5k               | 48 / 473.9k / 3.5k             |
| test-repair         | 8/8         | 8/8  | 22.4 s   | 22.3 s | 53 / 155.7k / 3.2k               | 56 / 553.9k / 2.8k             |
| permission-denial   | 8/8         | 0/8  | 5.6 s    | 11.5 s | 16 / 37.6k / 0.5k                | 24 / 224.6k / 1.0k             |
| tool-error          | 8/8         | 8/8  | 7.3 s    | 9.6 s  | 24 / 57.5k / 0.4k                | 24 / 224.7k / 0.4k             |
| stream-interruption | 7/8         | 0/8  | 10.7 s   | 4.6 s  | 23 / 56.4k / 0.8k                | 8 / 74.4k / 0.2k               |

Phase latency (p50, from the same sweeps; a TypeScript first-output is the
first streamed part, a Rust one the first provider delta):

| phase                     | Rust    | TS      |
| ------------------------- | ------- | ------- |
| admission → first output  | 0.9-1.2 s | 9.4-16.7 s |
| first output → terminal   | 4.1-21.1 s | 0.03-6.2 s |
| terminal → verified       | 0.02-0.1 s | 0.0-0.01 s |

Reading the table:

- **The two failures are product-parity facts, not model failures.** The frozen
  permission-denial task requires a durable `permission.denied` receipt; the
  TypeScript product has no observable event for a rule-based denial, only a
  generic tool failure, so the receipt cannot exist. The interrupted-turn task
  requires a mid-body provider transport break followed by recovery; the
  TypeScript product has no continuation path, so a host interruption ends the
  run. Both gaps are recorded rather than papered over; closing them is
  product-side work.
- **The interrupted-turn Rust figure needs pacing.** The first unpaced batch
  passed 3/8: provider edge risk control answered `403` to bursts of the extra
  proxy connection the transport break requires. Re-running with a 5 s pause
  between runs passed 7/8 (the remaining failure is another 403). The mechanism
  itself is deterministic once the provider accepts the connection: the receipt,
  the once-only side effect, and the completed continuation all hold in every
  run that reached it.
- **Cross-engine pairs are not profile-identical.** The effective tool
  surfaces differ by construction, so `fullSuiteComparable` stays `false`; the
  per-engine numbers above are the baseline, and pairing gates remain for
  client-facing cutover claims.
- **Rust input tokens are lower in every task** (e.g. read-only 98k vs 379k,
  test-repair 156k vs 554k). The comparison is not mechanism-isolated -- the
  tool surfaces and prompt assemblies differ -- but it is the reference point
  the efficiency work measures against.

Long-Session coverage is still open: the frozen fixture has one prompt per
task, so the R0 requirement needs either a multi-input fixture or a separately
recorded long-session run before A1 is complete.

## Stale-edit recovery measurement (2026-10-14)

Mechanism: read-registered snapshots plus anchored rebase on the stale path
(#804); the drift control rewrites a workspace path the moment its read settles
(#805). Arms: `small-edit`, `multi-file`, and `test-repair`, eight repetitions
each with one drifted source file, `--edit-recovery on` versus `off` (engine
revisions `c3aaac1f` and `ae435bf8`; the only engine difference is the serve
option whitelist fix).

| task        | recovery on                             | recovery off                            |
| ----------- | --------------------------------------- | --------------------------------------- |
| small-edit  | 8/8 · p50 24.9 s · 59 attempts · 169.5k/3.3k | 6/8, 1 rejected · p50 28.1 s · 51/7 runs · 144.9k/2.7k |
| multi-file  | 8/8 · 32.7 s · 64 · 200.3k/5.0k         | 8/8 · 36.2 s · 64 · 201.2k/5.3k         |
| test-repair | 8/8 · 33.3 s · 70 · 219.4k/4.3k         | 8/8 · 38.1 s · 71 · 222.0k/4.5k         |

Reading the events of a drifted run shows why the two arms converge: the frozen
edit targets are single-line files, so the read registers a one-line snapshot.
When the drift changes that line, the rebase has no usable context anchor and
refuses with `unanchored` -- the documented rule that a position is never
guessed -- and the model pays one re-read turn in both arms. The measured
differences are therefore mostly that refusal path: a 10-13% p50 edge for
recovery on, and `small-edit` holding 8/8 against 6/8, with attempts and tokens
inside noise. The anchored rebase itself is pinned by the deterministic tests
(multi-line snapshots rebase between unique anchors; ambiguous, unanchored, and
disproportionate drift keeps the stale failure; `replace_all` never rebases).
Quantifying the live benefit needs a multi-line editable fixture, which is the
next candidate addition to the suite.

## Long-session live record (2026-10-14)

The suite-v2 `long-session` task passed on its first live run: one initial input
plus four follow-ups on the same Session, 59 provider attempts, 44 tool calls,
78.7 s, workspace test exit 0, and the answer carries `LONG_SESSION_OK`. This
closes the R0 long-Session coverage item.

## Post-edit diagnostics measurement (2026-10-14)

Arms: `small-edit` and `multi-file`, eight repetitions each against a real
TypeScript language server (`typescript-language-server`, host config outside
the workspace), `--lsp-diagnostics on` versus `off`, engine revision
`44d8bffe3`.

| task       | diagnostics on                        | diagnostics off                       |
| ---------- | ------------------------------------- | ------------------------------------- |
| small-edit | 8/8 · p50 25.1 s · 45 attempts · 121.8k/2.3k | 8/8 · p50 24.7 s · 45 attempts · 121.8k/2.3k |
| multi-file | 8/8 · p50 30.4 s · 48 attempts · 141.1k/4.3k | 8/8 · p50 32.1 s · 48 attempts · 140.8k/4.4k |

The two arms are equivalent, and the small-edit input tokens are identical to
the byte, so no diagnostics report was attached in those runs: the frozen edits
are type-clean, and the report only carries error- and warning-severity
diagnostics. What the arm comparison does show is the cost side: with the read
warm-up in place, the edit's synchronous diagnostics wait added no measurable
latency (p50 within noise), and the ablation changed nothing else. The report
path itself is pinned by the LSP fixture tests (a real diagnostic attaches as
`diagnostics`; the ablation skips warm-up and report). Demonstrating the
repair-loop value needs a fixture whose edit introduces a typed error, which is
the same fixture-gap the A2 and A3 measurements record.

## Failure classification and wasted turns (2026-10-14)

Vocabulary: `loop.continuation` names why a run continued on its own
(`empty-completion` and the transport-recovery continuation), `loop.stopped`
names why a self-driven loop closed (`empty-completion`, `no-progress`, and the
goal loop's `budget`/`max-iterations`). The runner records both reason lists per
run as `evidence.loops`, so sweep reports can count wasted turns and classified
closures directly.

Behavior pinned by tests rather than a live sweep:

- An empty provider completion (no text, no tool calls) admits one bounded
  reminder and continues; a second consecutive one is a classified closure and
  the run fails, instead of the previous silent completion (`empty_completion`
  tests).
- A real user input resets the empty-completion counter; an autonomous goal that
  classified its own stall keeps its closure (`goal_continuation` tests).

A live sweep cannot force the model into an empty completion honestly, so the
recorded N=8 baselines show an empty `loops` list on normal tasks: the
classification exists, and its incidence on well-behaved tasks is zero -- which
is itself the wanted outcome.

## Suite-v3 carriers: anchored rebase and typed repair (2026-10-14)

The v3 carriers give A2 and A7 the measurement their earlier single-line
fixtures could not produce. Eight repetitions per arm, engine revision
`9255cc52f`; the only difference between the arms is the mechanism switch.

| arm                            | passed | p50     | attempts/run | input tokens | output tokens |
| ------------------------------ | ------ | ------- | ------------ | ------------ | ------------- |
| multi-line-edit, recovery on   | 8/8    | 22.3 s  | 6.0          | 142,227      | 2,878         |
| multi-line-edit, recovery off  | 8/8    | 27.1 s  | 7.6          | 181,949      | 3,387         |
| typed-repair, diagnostics on   | 8/8    | 20.7 s  | 5.0          | 115,933      | 3,216         |
| typed-repair, diagnostics off  | 8/8    | 21.6 s  | 5.2          | 122,002      | 3,308         |

With drift injected into a multi-line target, the anchored rebase removes about
1.6 provider turns per run (-21%), 22% of the input tokens, and 18% of the p50
latency, at the same 8/8 success. The post-edit diagnostics report removes about
0.2 turns per run (-4%), 5% of the input tokens, and 4% of the p50 latency on a
type-inconsistent repair, also at 8/8. The gaps are attributable because the
arms share the same binary, profile, and task; the mechanism switch is the only
variable, and the receipts corroborate it: the recovery-on runs record no
`tool.error` at all, while every recovery-off run records one from the stale
edit. On the type-clean carriers the same report attaches nothing and costs
nothing measurable, which is the expected noise behaviour.

## Large-file retrieval measurement (2026-10-14)

Carrier: suite-v4 `large-file`, a deterministic source above the whole-file read
bound whose bug sits at one known line; four repetitions per arm.

With process authority the arms are equivalent -- the shell's grep and sed reach
the bug at the same cost as the native path:

| arm                                 | passed | p50    | attempts | input tokens |
| ----------------------------------- | ------ | ------ | -------- | ------------ |
| pre-A3 (no line windows)            | 4/4    | 37.4 s | 29       | 90,392       |
| line windows + 1 MiB mutation bound | 4/4    | 37.8 s | 28       | 93,392       |

Without process authority the capability is decisive: before line windows the
engine cannot read the file at all and no shell exists to bypass that, so the
repair is impossible; with windows plus matching mutation and patch bounds every
run repairs it:

| arm                                 | passed | p50    | attempts | input tokens |
| ----------------------------------- | ------ | ------ | -------- | ------------ |
| pre-A3                              | 0/4    | 29.0 s | 21       | 36,982       |
| line windows + 1 MiB mutation bound | 4/4    | 39.2 s | 31       | 88,324       |

The native path is not cheaper than the shell; it is the only path when the
shell is denied, and the extra turns and tokens it spends there are the price of
the capability.

Two engine gaps this measurement found are fixed in the same change: an
oversized whole-file read now answers `TooLarge` and points at the line window,
and the mutation and patch per-file bounds were raised from 32 KiB to 1 MiB so a
window-read file can actually be edited (a small edit on a large file is pinned
by a test). One failure mode belongs to the model, not the engine: after
mangling the 64-character fingerprint it abandoned `edit_file` for a patch,
which the raised bound now also accepts.

## Wider reporting view (2026-10-14)

`baseline-summary-cli` prints one row per engine and task with pass rate, p50,
provider turns, tokens, tool calls, receipts, and loop classifications; it
tolerates evidence recorded before a field existed. The recorded v1 baseline
reads as follows (eight repetitions per task):

| engine | task | passed | p50 | turns/run | input tokens | output tokens | tools/run | receipts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rust | read-only | 8/8 | 12.7 s | 5.0 | 98,346 | 1,150 | 4.0 | tool.error |
| rust | small-edit | 8/8 | 15.1 s | 5.5 | 118,330 | 2,259 | 5.9 | - |
| rust | multi-file | 8/8 | 22.2 s | 6.0 | 141,426 | 4,489 | 10.3 | - |
| rust | test-repair | 8/8 | 21.6 s | 6.6 | 155,716 | 3,222 | 8.0 | - |
| rust | permission-denial | 8/8 | 5.2 s | 2.0 | 37,608 | 489 | 1.0 | permission.denied, tool.error |
| rust | tool-error | 8/8 | 7.2 s | 3.0 | 57,496 | 376 | 2.0 | tool.error |
| rust | stream-interruption | 3/8 | 8.3 s | 2.1 | 41,238 | 544 | 1.8 | provider.interrupted |
| typescript | read-only | 8/8 | 16.7 s | 5.0 | 379,298 | 1,269 | 5.3 | - |
| typescript | small-edit | 8/8 | 22.3 s | 6.3 | 477,465 | 2,443 | 8.0 | - |
| typescript | multi-file | 8/8 | 22.1 s | 6.0 | 473,906 | 3,493 | 9.5 | - |
| typescript | test-repair | 8/8 | 21.7 s | 7.0 | 553,906 | 2,783 | 9.0 | - |
| typescript | permission-denial | 0/8 | 11.4 s | 3.0 | 224,603 | 985 | 2.0 | tool.error |
| typescript | tool-error | 8/8 | 9.4 s | 3.0 | 224,712 | 360 | 2.0 | tool.error |
| typescript | stream-interruption | 0/8 | 4.5 s | 1.0 | 74,416 | 160 | 1.0 | - |

The same view over the suite-v3 and suite-v4 carriers is the measurement table
in the earlier sections. The clearest reading is read-only retrieval: the same
success on the same task costs the Rust engine about a quarter of the input
tokens (98k against 379k) and slightly fewer turns and tool calls, which is the
reference point the efficiency work measures against.

Reading tokens cannot be split out of the per-attempt totals: the engine
accounts usage per provider turn, not per tool, so tool calls stand in as the
retrieval-effort proxy.

## Short-anchor syntax and edit-wording ablation (2026-10-14)

A2's remaining acceptance asked for an independent evaluation of a model-visible
edit syntax and its reminder wording, so two engine revisions were compared on
the v3 edit carriers: main with the existing exact-match guidance, and a variant
that accepted `anchor`/`new_text` as a concise alternative and told the model to
name the replaced text by the shortest substring that occurs exactly once.

| task | arm | passed | p50 | turns/run | input tokens | output tokens | tools/run | receipts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| multi-file | exact match | 4/4 | 32.8 s | 6.0 | 73,624 | 2,369 | 10.0 | - |
| multi-file | shortest anchor | 3/4 | 39.0 s | 8.0 | 106,216 | 3,259 | 12.5 | tool.error |
| typed-repair | exact match | 4/4 | 25.1 s | 5.0 | 57,246 | 1,581 | 5.5 | - |
| typed-repair | shortest anchor | 4/4 | 34.7 s | 6.3 | 77,140 | 2,471 | 7.3 | tool.error |

The shortest-anchor wording loses on every axis: 33-38% more turns, 35-44% more
billed input, 38-56% more output, a new class of rejected edits (`tool.error`),
and one lost run. The rejections are the mechanism: a fragment chosen for being
short is more often ambiguous, so the model spends turns repairing edits the
longer exact match never failed on. An N=8 sweep of the same variant could not be
used as the comparison: nine of its thirty-two runs produced no judged sample in
a provider-side window this measurement does not attribute to the change.

The concise `anchor`/`new_text` form stays in the schema, so a model that writes
those names spontaneously is accepted rather than rejected, but the
measured-good exact-match guidance is restored verbatim.

## Prefix-cache policy and measured cache reads (2026-10-14)

`--prompt-cache on|off` (#827) carries an explicit policy into the provider: `on`
marks the stable prefix -- system prompt and tool catalog -- with a cacheable
breakpoint for the provider that requires one. `off` stays the default, so no
provider's caching behavior changes unless a caller asks for it.

The frozen suite-v3 carriers were run without the mark (the sweep provider caches
prefixes on its own), and each attempt's durable usage records the provider's
cache accounting, so these shares cost no extra provider time to measure:

| task | runs | cache read tokens | billed input tokens | share |
| --- | --- | --- | --- | --- |
| small-edit | 8/8 | 13,952 | 124,041 | 11.2% |
| multi-line-edit | 8/8 | 21,632 | 121,157 | 17.9% |
| multi-file | 8/8 | 38,656 | 146,576 | 26.4% |
| typed-repair | 8/8 | 37,120 | 115,699 | 32.1% |

Reads cover 11-32% of billed input and the provider reported no cache writes, so
the write side stays invisible to this provider. The share grows with the number
of turns a run takes, because the prefix is re-sent every turn, which is why the
longest carrier shows the highest share. Whether a turn's prefix is byte-identical
to the previous turn's is asserted separately by `tests/prefix_stability.rs`.
Billed cache write and TTFT remain unmeasured per provider: the sweep provider
reports neither.
