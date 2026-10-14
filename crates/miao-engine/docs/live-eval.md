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

## Frozen eight-task fixture contract

`packages/miao/src/engine/baseline.ts` defines an explicit versioned suite with
UTF-8 fixture contents, prompts, immutable oracle/config files, edit allowlists,
and suite/task SHA-256 fingerprints. Every attempt initializes a fresh directory;
existing workspaces are never overwritten. The eight classes are read-only
navigation, small edit, multi-file repair, failing-test repair, permission denial,
tool-error recovery, interrupted-turn recovery, and long-session delivery. The
long-session task carries four follow-ups that continue the same Session after
each earlier input settles, so accumulated history and the queue boundary are
part of the measured run; the oracle still checks only the final artifact and
the final answer. Suite version 2 adds it, so version 1 samples (including the
2026-10-14 recorded baseline) are foreign to this contract and must not be
paired with it.

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
