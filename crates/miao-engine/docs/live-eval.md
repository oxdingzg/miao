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

## Frozen seven-task fixture contract

`packages/miao/src/engine/baseline.ts` defines an explicit versioned suite with
UTF-8 fixture contents, prompts, immutable oracle/config files, edit allowlists,
and suite/task SHA-256 fingerprints. Every attempt initializes a fresh directory;
existing workspaces are never overwritten. The seven classes are read-only
navigation, small edit, multi-file repair, failing-test repair, permission denial,
tool-error recovery, and interrupted-turn recovery.

The artifact verifier checks immutable files, unexpected files/symlinks, expected
outputs, and real workspace test subprocess exit codes. It refuses to execute a
tampered test oracle. The interruption fixture appends a marker, so repeated
completed effects produce an observable failing artifact instead of being hidden
by an idempotent overwrite.

Artifact success is not an execution or quality verdict. The verifier always
returns `executionVerdict: "unverified"`; actual durable backend receipts,
terminal outcome, answer checks, fixed model/agent/permission parameters,
all-attempt usage, and wall-clock samples are still required by the comparison
runner. In particular, unchanged protected files alone do not prove a permission
denial, and an audit marker alone does not prove stream recovery.

The oracle calibration tests run from `packages/miao`:

```sh
bun test test/engine/baseline.test.ts
```

They prove that the initial defective programs fail, repaired programs pass,
immutable-oracle tampering cannot bypass verification, repeated mutation fails,
and caller-modified task metadata cannot change the frozen contract. These are
fixture/oracle checks, not live-agent measurements or evidence for default-engine
promotion.
