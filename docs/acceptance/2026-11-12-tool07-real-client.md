# TOOL-07 — real-client retrieval: quality, cost, and latency on live traffic

**Item:** TOOL-07 (#1960) · Criterion 4's real-client half.
**Tree:** `main` at `33cd31859a` (the engine's Exa REST backend and wire
contract are unchanged since the `2026-11-07` record; nothing about the
measurement depends on a newer tree).
**Provider:** Exa, `https://api.exa.ai/search`, the same wire contract
`crates/miao-engine/src/web.rs` speaks (`query`, `numResults`, `type`,
`contents.text.maxCharacters`), authenticated by the operator's key.

## Commands

```sh
for q in \
  "windows STATUS_STACK_OVERFLOW rustc infinite recursion" \
  "parallel.ai search api pricing" \
  "openai chat completions streaming sse format"; do
  curl -sS -X POST https://api.exa.ai/search \
    -H "x-api-key: $EXA_API_KEY" -H "Content-Type: application/json" \
    -d "{\"query\":\"$q\",\"numResults\":8,\"type\":\"auto\",
        \"contents\":{\"text\":{\"maxCharacters\":1000}}}"
done
```

## Observed (2026-11-12)

| query | HTTP | latency | results | Exa cost | notes |
| --- | --- | --- | --- | --- | --- |
| windows STATUS_STACK_OVERFLOW rustc infinite recursion | 200 | 1.88 s | 8 | $0.007 (neural) | surfaced rust-lang#152172/#92524/#71635 — directly the #2926 failure class |
| parallel.ai search api pricing | 200 | 2.07 s | 8 | $0.007 | pricing/API pages, not recall-shaped |
| openai chat completions streaming sse format | 200 | 1.15 s | 8 | $0.007 | SDK/reference pages |

Every result carries a source URL and a 1000-character text body (the
`maxCharacters` budget is honored per result). `numResults=8` is honored.

## Real client end-to-end

The same key through the product (`MIAO_WEB_SEARCH_PROVIDER=exa
EXA_API_KEY=… miao`, TUI in a real tmux pane): the model called `websearch`
with the query above and rendered the top results with their URLs into the
transcript — including `rust-lang/rust#140725` ("stack overflow while compiling
async recursion"), which is the lead now tracking #2926's own Windows stack
overflow.

## Criterion 4 — accepted

Quality (per-result URLs and bodies in each format's own vocabulary), cost
(`costDollars` per query), and latency (per-query wall clock) are now measured
on real traffic through the product's own backend contract. Together with the
`2026-11-07` record (criteria 1–3), TOOL-07's criteria are all accepted.

## Not covered here

- The Keenable search provider (`api.keenable.ai/v1/search`, `X-API-Key`)
  also works with the operator's key (10 000-credit trial) — adding it as a
  third REST backend is future implementation, not required by TOOL-07.
