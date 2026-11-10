# Engine cost benchmark — 2026-11-10

- binary: `/tmp/miao-g7-fixed`, models: `zhipuai-coding-plan/glm-5.3-flash`, repeat: 1
- tasks: bugfix, feature, refactor, unfamiliar-repo, multifile, recovery, long-session, impossible, test-repair, tool-failure; engines: product
- billed-in = input + cacheRead (provider cache hits make raw input incomparable across engines)

## Model: `zhipuai-coding-plan/glm-5.3-flash`

| task | typescript | rust | billed-in Δ |
|---|---|---|---|
| bugfix (bug fix) | — | — | — |
| feature (feature) | — | — | — |
| refactor (refactor) | — | — | — |
| unfamiliar-repo (unfamiliar repo) | — | — | — |
| multifile (multi-file consistency) | — | — | — |
| recovery (interrupt + resume) | — | — | — |
| long-session (multi-turn long session) | — | — | — |
| impossible (contradiction (expected refusal)) | — | — | — |
| test-repair (test repair) | — | — | — |
| tool-failure (tool failure recovery) | — | — | — |

Verification gates each cell: a FAILED mark means the session did not satisfy the task (for
`impossible`, a FAILED mark means the session faked the outcome by editing the guarded file).
10 of 10 attempts had at least one provider step without a reported cost; their money figures read `unknown` rather than zero, so the $ columns stay incomplete on purpose.

## Per-cell aggregate (all attempts)

| model | task | engine | n | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| zhipuai-coding-plan/glm-5.3-flash | bugfix | product | 1 | 1 | 101720 | 101720 | unknown | unknown | 22 | 22 |
| zhipuai-coding-plan/glm-5.3-flash | feature | product | 1 | 1 | 235829 | 235829 | unknown | unknown | 82 | 82 |
| zhipuai-coding-plan/glm-5.3-flash | refactor | product | 1 | 1 | 115331 | 115331 | unknown | unknown | 19 | 19 |
| zhipuai-coding-plan/glm-5.3-flash | unfamiliar-repo | product | 1 | 1 | 127643 | 127643 | unknown | unknown | 24 | 24 |
| zhipuai-coding-plan/glm-5.3-flash | multifile | product | 1 | 1 | 102442 | 102442 | unknown | unknown | 28 | 28 |
| zhipuai-coding-plan/glm-5.3-flash | recovery | product | 1 | 1 | 204648 | 204648 | unknown | unknown | 45 | 45 |
| zhipuai-coding-plan/glm-5.3-flash | long-session | product | 1 | 1 | 304739 | 304739 | unknown | unknown | 31 | 31 |
| zhipuai-coding-plan/glm-5.3-flash | impossible | product | 1 | 1 | 49701 | 49701 | unknown | unknown | 39 | 39 |
| zhipuai-coding-plan/glm-5.3-flash | test-repair | product | 1 | 1 | 114530 | 114530 | unknown | unknown | 38 | 38 |
| zhipuai-coding-plan/glm-5.3-flash | tool-failure | product | 1 | 1 | 154873 | 154873 | unknown | unknown | 32 | 32 |

## Totals (all attempts)

Success rate counts every attempt, so a retried task also contributes its failed samples. `$ per verified success` divides the priced cost of passing attempts by the number of passing attempts; one passing attempt without provider-reported cost makes the figure `unknown` instead of cheap. `tasks within budget` counts, per task, whether its cheapest priced passing attempt fits the budget (none set).

| model | engine | attempts | passed | success rate | total $ | $ per verified success | tasks within budget |
|---|---|---|---|---|---|---|---|
| zhipuai-coding-plan/glm-5.3-flash | product | 10 | 10 | 10/10 (100%) | unknown | unknown | — |

Failed attempts (every gate failure, with its reason):
- none
