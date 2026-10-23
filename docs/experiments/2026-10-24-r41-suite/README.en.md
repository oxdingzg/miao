# 2026-10-24 R4.1 representative-task quality acceptance (suite-v6, all 15 classes × 3 × both engines, glm-5.3-flash)

Owner-authorized R4.1 acceptance: the suite-v6 frozen task set, 15 classes × 3 repetitions × both engines (45 runs per arm), model `zhipuai-coding-plan/glm-5.3-flash`; baseline and arm details in `manifest.json`. The TS arm runs the product source entry (isolated data dir + slim credential snapshot); the RS arm runs the engine binary over an explicit openai-chat route.

## Per-class results

| task                | TS gates  | RS gates  | TS wall (s) | RS wall (s) |
| ------------------- | --------- | --------- | ----------- | ----------- |
| create-module       | 3/3       | 3/3       | 75          | 79          |
| docs-sync           | 3/3       | 3/3       | 74          | 96          |
| large-file          | 3/3       | 3/3       | 98          | 132         |
| long-session        | 3/3       | 3/3       | 269         | 506         |
| multi-file          | 3/3       | 3/3       | 94          | 115         |
| multi-line-edit     | 3/3       | 3/3       | 56          | 77          |
| multi-read          | 3/3       | 3/3       | 54          | 28          |
| permission-denial   | **0/3**   | **3/3**   | 99          | 99          |
| read-only           | 3/3       | 3/3       | 45          | 43          |
| rename-symbol       | 3/3       | 3/3       | 90          | 101         |
| small-edit          | 3/3       | 3/3       | 83          | 66          |
| stream-interruption | 0/3       | 0/3       | 42          | 12          |
| test-repair         | 3/3       | 3/3       | 76          | 85          |
| tool-error          | 3/3       | 3/3       | 50          | 59          |
| typed-repair        | 3/3       | 3/3       | 72          | 93          |
| **total**           | **39/45** | **42/45** | 1,277       | 1,591       |

## Acceptance conclusion

1. **R4.1 met: RS 42/45 (93.3%) ≥ TS 39/45 (86.7%)** — the native engine is not weaker than TypeScript, and wins the permission-denial class outright (TS 0/3, RS 3/3: the native permission gate correctly refuses out-of-policy writes and leaves the tree untouched).
2. `stream-interruption` failed on both arms (0/3): the class is harness-timing sensitive and historically unstable (both arms failed on 10-21; both passed on the sol round). Tracked separately as a harness-sensitive class; it does not change this acceptance.
3. **Wall clock**: RS +25% overall (1591s vs 1277s), driven by long-session (506 vs 269) and longer outputs; RS is faster on multi-read (28 vs 54).
4. Cross-referencing the cost batches: RS turns/outputs are larger (more complete answers), while per-step latency and cache behavior remain the open cost question (see 2026-10-23-g5-official).

## Evidence boundary

- `ts/` and `rs/` each contain `samples.json` (per-run outcome/elapsedMs/attempts) and `evidence/` (per-run gate and assessment records); `runs/` and `sweep.json` are raw sweep artifacts.
- Credentials were injected as a slim snapshot (the credential table only, 8 rows); no secret material is committed.
