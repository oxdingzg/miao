# 15. Cross-Engine Journal Parity

Date: 2026-10-15
Status: Accepted

## Context

The blackbox replay is the product's engine-selection insurance: a journal the
Rust engine records must replay through the TypeScript core byte-for-byte,
because either engine may serve a Session until B6 retires the legacy path.
Twice in one day this contract caught real drift (#842, #844): a journaled
payload changed on the Rust side only, and every cross-engine replay failed
with `Blackbox request mismatch`.

Both failures were caught late -- after push, at CI -- even though the change
was local. The cost is a forced rebase-and-rerun cycle on a hot main branch.

## Decision

1. **A journal payload change is a cross-engine change.** Adding, removing, or
   re-shaping any event kind the journal emits -- including fields on
   `usage`, `provider.started`, `tool.parallel.started`, lifecycle events --
   must land in `packages/core`'s runner in the same pull request, or the
   branch rebases onto a main where both sides already agree.
2. **Wall-clock never enters the journal** (ADR-13's rule, generalized): any
   duration, latency, or timestamp that replay cannot reproduce belongs in a
   side table (`engine_timing`) or the ephemeral progress feed, never in a
   pinned payload.
3. **Engine-only event families are the exception, and stay named.**
   `SubagentStop` and the role evidence events have no TypeScript emitter
   today; they are safe only because no recorded tape exercises them. Adding
   tape coverage for one of those families simultaneously lands the
   TypeScript emitter.

## Consequences

- The fastest drift check is local: `bun test test/engine/` (packages/miao)
  replays through the TypeScript core without any provider or binary. Run it
  before pushing any change that touches `crates/miao-engine/src` journal
  writes.
- When the blackbox job fails with a payload difference, the fix is either
  "land the TypeScript twin" or "take the field out of the journal" -- never
  a tape regeneration.
- B4's acceptance (dual-engine real-client verification) builds on this
  parity; B6 (legacy retirement) ends it.
