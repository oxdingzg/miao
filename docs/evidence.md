# Evidence: four separate records, never merged into one claim

A change is not accepted because its CI is green, and a published artifact is not
a release. This file keeps the four kinds of evidence apart, says what each must
contain, and indexes where the current records live.

## The four kinds

| Kind | Answers | Must contain | Never implies |
| --- | --- | --- | --- |
| **Implementation** | Did we build it, and does it hold? | PR/commit, tests, CI run for the exact commit | That it is accepted, beneficial, or released |
| **Offline / real-client acceptance** | Does it behave for the client the person uses? | client, its version, server SHA, protocol, steps, raw result | That it is beneficial |
| **Benefit acceptance** | Is it better, by how much, at what cost? | frozen suite, start commit, model, repeats, verifiers, every sample including failures, cost/time | That it is released |
| **Release** | Is the exact artifact published and recoverable? | tag, target commit, artifact hashes, install smoke, rollback command | That acceptance passed |

Two rules follow, and both have been violated in this repository's history:

- **CI success is implementation evidence only.** It says the checks for that
  commit passed, not that the work is better or that anyone accepted it.
- **An artifact is not a release.** A build on a machine, or a file attached to a
  run, is evidence of the build. A release needs the tag, the hashes and an
  install that was actually performed.

## Current records

| Record | Kind | Version / commit | Scope |
| --- | --- | --- | --- |
| `docs/experiments/2026-11-01-val01-repeat-10-two-arm/` | benefit acceptance | CLI `808cc110e`, engine `071eed588d` | ten families, both placements, 10 repeats, recomputable via `analyze.py` |
| `docs/experiments/2026-11-01-val03-mechanical-half/` | benefit acceptance | main, 2026-11-02 | six interaction tasks: keystrokes, time-to-state, cost of a correction |
| `docs/experiments/2026-11-01-startup-latency/` | benefit acceptance | main, 2026-11-01 | cold/warm first frame, ready-to-type, ready-to-submit |
| `docs/experiments/2026-11-01-ts-suite-real-model/` | benefit acceptance | main, 2026-11-01 | TS suite against a real model |
| `crates/miao-engine/docs/artifact-acceptance-0.2.25.md` | release | 0.2.25 | artifact hashes and install smoke for that version |
| `specs/rust-retirement-gates.md` | gate + release | candidate `v0.3.25` (`2af2a57a85`) | G1–G8 status, opened observation window, packaged-artifact startups |
| `crates/miao-engine/docs/product-acceptance-matrix.md` | real-client acceptance | per client | what each client must demonstrate |

The index is not exhaustive by design: a record belongs here when a claim cites
it, and the claim itself must name the record rather than restate its numbers.

## Rules for adding a record

1. State the commit and version the record is bound to; a record without a
   binding cannot be compared with a later one.
2. Keep the raw samples. A summary that cannot be recomputed from the samples is
   a claim, not a record.
3. Record failures and unknowns explicitly. An unknown price, an unpriced step, a
   delegated Session whose spend is not visible — each is stated, never folded
   into a total that looks complete.
4. Date any snapshot of a live status (roadmap, matrix), and say when it was last
   reviewed. A snapshot with no date reads as current when it is not.
