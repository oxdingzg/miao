# Acceptance record — issue #2737 the sidebar reads as named scopes

Item: issue `#2737` ([TUI] sidebar 信息排版重设计：分节更清晰、密度更低). Tree: branch
`fix/issue2737-sidebar-redesign` commit `1294575166`, parent `origin/main` `ee67b013c4`. The
redesign itself landed on main via PR #2847 (`cc3e5f6d8f`, verified there by CI run
`42923272263`); this record re-runs its criteria on the current tree and pins the two rules that
landing left unpinned. Commands ran on the Linux build host (`xx02`) in a synced copy of this
tree, from `crates/miao-tui`, `cargo 1.99.1`, debug profile. A reviewer runs the same commands
from the same directory anywhere.

## What changed on top of #2847

- `every_section_header_opens_after_a_blank_row` now lists `▾ Usage · session` and
  `▾ Activity` — the two headers #2847 added — so a regression cannot glue either to the rows
  above; the fixture carries the usage an Activity section needs to print.
- `a_multi_model_lineage_reads_as_one_group_under_the_usage_header` pins the lineage rule the
  issue asked to follow #2736: one row per served model, opening the session scope directly
  under its header.

## Criterion — "Last 24h 直方图与统计行分组过密，考虑分区标题+留白"

| surface | command (`crates/miao-tui`) | observed |
| --- | --- | --- |
| every ▾ header opens after a blank row, the two scope headers included | `cargo test --lib every_section_header_opens_after_a_blank_row` | `ok` — the pinned list names `▾ Last 24h`, `▾ Usage · session`, `▾ Activity`, `▾ Mode`, `▾ Changes`, `▾ Goal`, `▾ Plan`, `▾ Todo` |

## Criterion — "lineage 已逐模型显示（#2736），多模型时的排版需跟随"

| surface | command | observed |
| --- | --- | --- |
| two served models read as one group under the session scope | `cargo test --lib a_multi_model_lineage_reads_as_one_group_under_the_usage_header` | `ok` — `▾ Usage · session` on row N, `glm-5 · chat ×3` on N+1, `claude-x · responses ×1` on N+2 |

## Criterion — "retried / failed attempts / needs you / subagents 等状态行的优先级与去重"

| surface | command | observed |
| --- | --- | --- |
| abnormal first, then supervision, then delegation | `cargo test --lib the_usage_scopes_are_ordered_and_abnormal_rows_come_first` | `ok` — painted order `retried` < `needs you` < `subagents`; `needs you 1` with no `0 answer` / `0 reject` parts; `retried 2 · 1 failed attempt · 5 attempts` on one row; a child whose attempts equal its settled turns carries no attempts suffix |

## Criterion — "保持 42 列宽度、单 hairline 分隔、monochrome 可用"

| surface | command | observed |
| --- | --- | --- |
| the column's geometry and its hairline survive untouched | `cargo test --lib the_transcript_the_composer_and_the_sidebar_share_their_edges` | `ok` — the redesign changed rows, not the layout: `SIDEBAR_WIDTH` stays 42 and the column keeps its single left rule |
| priority survives without colour | `cargo test --lib the_usage_scopes_are_ordered_and_abnormal_rows_come_first` | `ok` — the pin reads painted rows only, so order carries the hierarchy a monochrome terminal cannot get from fg colour |

## The whole crate around it

`cargo test --lib` — `test result: ok. 647 passed; 0 failed; 0 ignored; 0 measured; 0 filtered
out; finished in 1.62s`.

## CI

- The landed redesign: PR #2847 green on CI run `42923272263` (head `a5a06f4f7fc4`).
- The pins on this tree: PR #2899 green on CI run `43015547098` (head `b5560b209f`).

## Staying open

- The release stamp: no published release contains this tree yet.
