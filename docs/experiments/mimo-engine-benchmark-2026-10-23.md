# mimo-v2.6-flash engine benchmark — 2026-10-23

A full `script/engine-benchmark.ts` round on the opencode-go subscription
gateway model `opencode-go/mimo-v2.6-flash`, comparing the TypeScript engine
(default) against the Rust engine (native placement via `MIAO_ENGINE_STORAGE`,
engine binary via `MIAO_ENGINE_BIN`).

## Why a patched engine binary

The rust arm cannot run against this gateway without #1252 (merged
2026-10-23, `f5fbc26920`). The gateway emits every absent Chat Completions
delta field as an explicit null (`"tool_calls": null` on every frame), which
the pre-fix parser rejected as `invalid Chat Completions frame` on the first
frame of every stream: the first pilot run recorded **0 tokens harvested, gate
failures on all rust cells, exit within ~6s** (TS cells in the same pilot
passed). The rerun below uses a binary built from the same tree as the merged
fix; both arms therefore run product code at `f5fbc26920` (TS from source,
rust from that build).

## Method

- harness: `script/engine-benchmark.ts` (7 task families, verification gate per cell)
- model: `opencode-go/mimo-v2.6-flash`; repeat: 2 (best-of-2 in the top table, per-cell p50/p95 in the aggregate table); 28 runs total
- billed-in = input + cacheRead; both arms same prompts, fresh workspace per cell
- catalog prices (opencode-go): input $0.14/M, output $0.28/M, cache read $0.0028/M

## Results

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | 5t · 74643b-in (5395in/69248cached)/203out · $0.0010 · 26s | 7t · 168324b-in (85636in/82688cached)/815out · $0.0000 · 95s | 126% |
| feature (feature) | 5t · 76431b-in (6223in/70208cached)/314out · $0.0014 · 44s | 7t · 170708b-in (87060in/83648cached)/1182out · $0.0000 · 70s | 123% |
| refactor (refactor) | 7t · 105825b-in (5601in/100224cached)/401out · $0.0012 · 46s | 6t · 143499b-in (73163in/70336cached)/942out · $0.0000 · 35s · FAILED | 36% |
| multifile (multi-file consistency) | 5t · 78331b-in (16827in/61504cached)/748out · $0.0028 · 42s | 7t · 177967b-in (91375in/86592cached)/2004out · $0.0000 · 79s | 127% |
| recovery (interrupt + resume) | 5t · 76986b-in (6458in/70528cached)/330out · $0.0015 · 69s · resumed | 11t · 296406b-in (152278in/144128cached)/3456out · $0.0000 · 160s · resumed | 285% |
| long-session (multi-turn long session) | 9t · 134970b-in (5946in/129024cached)/529out · $0.0014 · 63s | 10t · 243314b-in (127858in/115456cached)/1847out · $0.0000 · 99s · FAILED | 80% |
| impossible (contradiction (expected refusal)) | 4t · 60222b-in (6334in/53888cached)/329out · $0.0016 · 76s | 6t · 150395b-in (77883in/72512cached)/4607out · $0.0000 · 159s | 150% |

### Gates (performance)

- TypeScript: **14/14 attempts passed (7/7 families best-of)**.
- Rust: **9/14 attempts passed (5/7 families best-of)**. Failures:
  - `refactor` both attempts: `discount check failed` (edit wrong, gate not satisfied).
  - `long-session` both attempts: `bun test … 0 test files matching` — the fixture's test files were absent at verify time; TS runs on the identical fixture passed 2/2. Systematic within this arm; the harness deletes workspaces, so no further evidence was retained.
  - `recovery#1` (after resume): wrong escaping in `quote()` (real model/tool error); `recovery#2` passed.
- n=2 is directional, not statistical. The long-session pattern is systematic enough to deserve an engine-side investigation with evidence retention.

### Cost

- Engine-reported: TS total (best-of) **$0.0109**; rust reads **$0.0000** on
  every cell — the native placement of `miao run` does not price this
  provider's steps even though the catalog carries rates (pricing wiring is a
  follow-up; glm had the separate overlay gap fixed in #1251).
- Computed at catalog rates from the same token counts, rust total
  (best-of) ≈ **$0.1033**, ~**9.5× TS**. The driver is cache behaviour: rust
  carries 73k–152k *uncached* input per cell vs 5k–17k for TS (cache reads
  are similar), so most of rust's prompt is billed at full input rate. Why the
  rust request misses the gateway's prefix cache while the TS request hits it
  is the main open cost question (request-prefix/serialization divergence).
- Output is also larger on rust: 14853 vs 2854 tokens (best-of, 7 cells) —
  consistent with earlier rounds' observation that rust turns run longer.

### Time (wall clock, seconds)

- best-of sums: TS **366s** vs rust **697s** (rust +90%);
- per-cell worst attempt (aggregate rows): TS 525s vs rust 800s;
- rust is faster on exactly one family (`refactor`, 35s vs 46s) and up to
  2.7× slower on `impossible` (326s vs 121s).
- Caveat: with n=2 the harness's p50 and p95 both resolve to the same
  (worse) attempt; treat the aggregate columns as worst-case, best-of as the
  top table.

## Follow-ups

1. Wire the host price index into `miao run` native placement so rust cost
   columns price from the catalog (TS already does).
2. Investigate why rust streams miss the opencode-go gateway prefix cache
   (tools/system serialization vs TS) — this, not tokens generated, is what
   makes rust ~9.5× more expensive here.
3. Reproduce the `long-session` "0 test files" gate failures with workspace
   evidence retained before drawing a conclusion.
4. Deepseek on opencode-go still has no native route (unchanged, G5).
