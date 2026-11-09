# TOOL-07 — REST and MCP search backends: real selection, budgets, and an offline cost harness

**Item:** TOOL-07 · retrieval quality across search and fetch backends (#1960)
**Tree:** `feat/tool07-mcp-search` at `23d725d997`, parent `origin/main` (implementation PR #2521; the fetch-side record on an earlier tree is `2026-11-05-tool07-web.md`)
**Environment:** macOS arm64 build host, plain `cargo test --test web` from `crates/miao-engine`. Two earlier attempts on the shared Linux build host Elapsed inside an existing test's 5 s approval deadline while co-tenant builds held that host at load 200–300; the recorded run below is from the idle macOS host, and the harness lines it printed match those earlier attempts exactly.

## Criterion 1 — "Preserve distinct REST and MCP backend differences and support real selection between them."

**Command:** `cargo test --test web host_configuration_selects_the_answering_backend`
**Observed:** `test host_configuration_selects_the_answering_backend ... ok`

`SearchConfig::from_env` pins: nothing configured leaves the `websearch` tool absent rather than misdirected; an incomplete or unknown provider selection (`exa`, `mcp`, `ask-jeeves` without its pieces) fails closed with `ToolError::InvalidInput`; explicit exa and parallel selections answer with their own native wire contracts (`query`/`numResults` carrying the Exa key, `objective`/`mode` for Parallel); and an `mcp` selection answers through the server's own tool — advertising `max_results`, never `numResults` — while the configured REST endpoint is a closed port and an ambient `EXA_API_KEY` is set, so a fallback to Exa would have failed the call instead of returning the MCP answer.

Supporting pins already on `main`: `mcp_search_forwards_the_servers_own_schema_and_arguments`, `an_mcp_search_backend_without_its_catalogue_is_unusable_not_redirected`, `an_over_budget_mcp_answer_is_refused_rather_than_returned_in_part`.

## Criterion 2 — "Support source URLs, body budgets, redirect and auth failure handling, and in-flight cancellation."

**Command:** `cargo test --test web`
**Observed:** `test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s`

The fetch-side behaviours were first recorded on `37db1dc9c3` (`2026-11-05-tool07-web.md`); this run re-establishes them on the current tree: `fetch_renders_real_html_and_declared_text_encoding_and_bounds_output` (declared encoding, bounded output), `redirects_are_reauthorized_and_denied_targets_receive_no_request`, `search_redirects_never_forward_credentials_and_errors_hide_provider_bodies`, `searches_use_their_native_wire_contract_and_never_return_the_key` (the key is never echoed back), `cancellation_drops_an_inflight_web_response`, `runtime_fetch_waits_for_bound_controller_approval_before_any_http_request` (no request before controller approval), `an_over_budget_mcp_answer_is_refused_rather_than_returned_in_part`.

## Criterion 3 — "Measure retrieval quality and cost independently, without treating different result formats as identical recall."

**Command:** `cargo test --test web harness_records_payload_and_turn_costs_per_backend_without_equating_formats -- --nocapture`
**Observed:**

```
exa queries=3 turns=3 request_bytes=300 answer_bytes=633 citations=6
parallel queries=3 turns=3 request_bytes=444 answer_bytes=666 citations=6
mcp queries=3 turns=3 request_bytes=135 answer_bytes=414 citations=server-owned-format
```

A fixed three-query set runs against each backend's wire fixture. Per-backend turn counts and payload upper bounds (4096 B request, 64 KiB answer) are asserted, and the answer is bounded by the context budget (`contextMaxCharacters`), not just by the fixture. Quality evidence stays in each format's own vocabulary: REST backends report citation URLs — the same two documents behind both providers yield the same URL set while `exa` keeps `text` and `parallel` keeps `excerpts` — and the MCP backend reports a labelled server answer with no `results` array. The harness never reshapes one format into another's vocabulary or sums unlike recall into one number.

## Criterion 4 — "Link implementation PRs, offline and real-client acceptance records, and applicable versions with quality, cost, and latency evidence."

**Open.** This record is the offline half: implementation PR #2521 plus the harness above. The real-client half — live searches with real credentials, observed retrieval quality, and cost and latency on real traffic — has not been run, and this record deliberately does not claim it.

## Notes on this run

- Recorded run on an idle macOS arm64 host: cold compile 54.7 s, suite 0.12 s, 12/12 green. The harness report lines are deterministic and printed identically during the earlier loaded Linux attempts.
- The `mcp` suite on the Linux host printed `18 passed; 5 failed`, all five in `tests/mcp.rs` (one `NotFound` for a spawned stub, four timeout-class `Elapsed`) while co-tenant builds held the load above 200. This branch is `origin/main` plus a tests-only commit to `tests/web.rs`, so those failures are host contention, not this tree's change.
