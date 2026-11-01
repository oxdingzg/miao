# Results

| arm | runs | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| typescript | 100 | 91/100 | 240313 | 450448 | $0.0014 | $0.0040 | 33 | 81 |
| rust | 100 | 90/100 | 221630 | 433904 | $0.0013 | $0.0038 | 31 | 88 |

| arm | success rate | total $ | $ per verified success | tasks within budget |
| --- | --- | --- | --- | --- |
| typescript | 91/100 (91%) | $0.1797 | $0.0016 | 10/10 |
| rust | 90/100 (90%) | $0.1687 | $0.0015 | 10/10 |

| task | ts pass | rust pass | ts billed-in p50 | rust billed-in p50 | ts $ p50 | rust $ p50 | ts s p50 | rust s p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bugfix | 10/10 | 10/10 | 182213 | 184414 | $0.0010 | $0.0009 | 39 | 39 |
| feature | 10/10 | 10/10 | 215909 | 214590 | $0.0014 | $0.0013 | 44 | 42 |
| impossible | 10/10 | 10/10 | 151960 | 156178 | $0.0014 | $0.0016 | 26 | 28 |
| long-session | 10/10 | 9/10 | 305879 | 276977 | $0.0017 | $0.0013 | 70 | 74 |
| multifile | 10/10 | 10/10 | 222811 | 193030 | $0.0017 | $0.0016 | 25 | 22 |
| recovery | 10/10 | 10/10 | 437051 | 348134 | $0.0029 | $0.0024 | 61 | 64 |
| refactor | 9/10 | 10/10 | 279167 | 248692 | $0.0017 | $0.0013 | 40 | 44 |
| test-repair | 10/10 | 10/10 | 216319 | 221216 | $0.0012 | $0.0012 | 20 | 22 |
| tool-failure | 10/10 | 10/10 | 246571 | 221630 | $0.0013 | $0.0013 | 20 | 20 |
| unfamiliar-repo | 2/10 | 1/10 | 370598 | 350038 | $0.0038 | $0.0032 | 46 | 45 |

## Corrected view

`unfamiliar-repo` could not parse before #2205 (see README), so the measured table above counts its failures as model results. This table replaces that family with its re-measured samples from `raw/<arm>/rerun/evidence/` and leaves every other sample untouched.

| arm | runs | passed | total $ | $ per verified success | tasks within budget |
| --- | --- | --- | --- | --- | --- |
| ts | 100 | 99/100 (99%) | $0.1544 | $0.0015 | 10/10 |
| rust | 100 | 99/100 (99%) | $0.1475 | $0.0015 | 10/10 |

Failed samples: 19 of 200 (all listed, none dropped).
- ts/refactor#5: discount check failed
- ts/unfamiliar-repo#10: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#2: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#3: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#4: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#5: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#7: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#8: bun test v1.3.14 (0d9b296a)
- ts/unfamiliar-repo#9: bun test v1.3.14 (0d9b296a)
- rust/long-session#10: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#1: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#10: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#2: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#3: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#4: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#5: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#6: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#7: bun test v1.3.14 (0d9b296a)
- rust/unfamiliar-repo#8: bun test v1.3.14 (0d9b296a)
