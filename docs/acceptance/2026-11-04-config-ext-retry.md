# Acceptance record — config, extensions and retries

Tree: `04dc191a01` (`fix(tui): give every cell a page background, and the divider to
the sidebar (#2480)`). The source was copied to the macOS build host and every command
below was run there from `crates/miao-engine/` with `cargo 1.99.1` (debug profile):

```sh
cargo test --locked --no-fail-fast --test config_explain --test config_reload_context \
  --test config_reload_mcp --test config_reload_models --test config_reload_policy \
  --test worker --test mcp --test hooks --test provider --test lsp --test formatter
# 6 + 1 + 4 + 1 + 3 + 12 + 23 + 7 + 11 + 7 (+1 ignored) + 2 passed, 0 failed

cargo test --locked --no-fail-fast --test routing --test variant_fallback \
  --test retry_attribution --test transport_retry --test first_event \
  --test progress_updates --test input_status
cargo test --locked --lib -- rate_limit
# 7 + 1 + 2 + 5 + 2 + 2 + 4 passed and 1 lib test passed, 0 failed
```

A reviewer runs the same commands from the same directory anywhere. The counts below are
what those runs printed on that tree.

These eight items were opened as "code exists, no acceptance run". This record is that
run. It does not claim more than the commands show: every criterion the run does not pin
is named **not accepted** with the reason, and the checkbox in the issue is only ticked
when a row below is a ✓.

## CFG-02 — explainable configuration sources and scope

| criterion | command | observed |
| --- | --- | --- |
| the final value, its source, the override order and the current session override can be shown | `cargo test --test config_explain` | 6 passed. `native_explanation_reads_stdin_preserves_precedence_and_redacts_overridden_values` reports the winning value with the layer it came from, preserves precedence, and redacts a value a higher layer overrode; `explain_reports_a_disabled_hook_with_its_flag` keeps a disabled hook visible instead of dropping it |
| session, project, global and managed settings are distinguished | same | **not accepted**: the run pins precedence and redaction, not a four-scope enumeration, and `src/config_scope.rs` has no managed layer |
| invalid values and unknown keys produce an actionable fix | same | **not accepted here**: `invalid_command_options_are_rejected`, `directory_discovery_and_source_errors_work_without_provider_configuration` and `malformed_utf8_reports_a_safe_error_instead_of_debugging_input_bytes` pin the error and redaction paths; the unknown-key/key-path message is pinned by the config golden suite (CFG-01), not by this entry |

## CFG-03 — incremental hot reload for services

| criterion | command | observed |
| --- | --- | --- |
| models, agents, MCP, LSP and instructions are reconfigured per service when they change | `cargo test --test config_reload_context --test config_reload_mcp --test config_reload_models --test config_reload_policy --test lsp` | 9 and 7 passed. `config_reload_swaps_and_reports_each_context_part` (instructions), `config_reload_rebuilds_and_reports_the_models_section`, `config_reload_reports_and_swaps_the_mcp_section`, `a_policy_rewrite_swaps_the_capability_gates_with_it`, `a_reload_reconciles_the_lsp_section_and_keeps_unchanged_connections`. **Agents are not covered**: a reload reports the agents section as unsupported (#2457) |
| an active turn accepts changes at a safe boundary | — | **not accepted**: no case keeps a provider turn running across a reload |
| user input, running tasks and existing connections are not rebuilt by unrelated changes | same | ✓ `reconcile_keeps_unchanged_connections_and_swaps_the_rest`, `an_invalid_manifest_changes_nothing`, `a_failed_rebuild_keeps_the_previous_connection_serving`, and the LSP reconcile case above |

## MOD-05 — explainable retries, rate limits, self-healing and fallback

The checklist for this item was lost from its body (progress notes overwrote the
template) and has been reconstructed from its own scope; these rows are keyed to the
reconstructed lines.

| criterion | command | observed |
| --- | --- | --- |
| a retry shows its attempt count, its reason and when the next attempt is due | `cargo test --test transport_retry --test retry_attribution --test routing` | 5 + 2 + 7 passed: `a_transport_failure_keeps_the_underlying_cause` keeps the cause, `retries_are_attributed_apart_from_the_turn_they_saved` separates retry spend, `concurrent_turns_each_have_three_attempts_without_budget_leakage` bounds three attempts per concurrent turn. **"When the next attempt is due" is not pinned here**: that is the status projection shipped in #1759 |
| a rate limit is named as a rate limit with the wait it imposes, not a generic failure | `cargo test --lib -- rate_limit` | 1 passed: `provider::retry_tests::a_rate_limit_pause_is_honoured_instead_of_the_short_backoff` honours the 429 pause instead of the short backoff |
| self-healing is reported as it happens, not only once it succeeds | `cargo test --test progress_updates --test transport_retry` | 2 + 5 passed: `a_provider_that_has_not_answered_yet_announces_the_wait`, `silent_tool_batches_trigger_request_only_guidance_and_visible_text_resets_it`, and `pre_output_transport_failure_is_retried` versus `post_output_transport_failure_is_not_replayed` |
| every fallback names what it fell back to and what was lost | `cargo test --test routing --test variant_fallback` | 7 + 1 passed: `rejected_primary_can_fallback_with_one_shared_retry_budget`, `accepted_body_transport_semantic_and_auth_failures_do_not_switch_model`, `configured_default_and_explicit_variants_preserve_fallback_authority_and_options` |
| the operator can cancel a run that is retrying without waiting for the next attempt | — | **not accepted**: no case cancels between attempts |

## EXT-01 — capability matrix for worker extensions

| criterion | command | observed |
| --- | --- | --- |
| the supported scope of each interface is listed | `cargo test --test worker` | 12 passed: `worker_lists_and_calls_a_tool` pins `tool.list`/`tool.call`; `worker_ask_relays_to_the_durable_question_flow` pins the mid-call ask. The written matrix is `crates/miao-engine/docs/extension-worker-capabilities.md`. UI host and provider hooks are **not** worker capabilities: hooks are `src/hooks.rs` and providers are native |
| real plugins have acceptance for start, failure, cancel, restart and version negotiation | same | start, failure and cancel ✓: `truncated_frame_degrades_the_worker`, `timeout_degrades_worker_without_leaving_a_reusable_partial_transport`, `missing_optional_worker_does_not_prevent_engine_admission`, `cancellation_interrupts_a_call_blocked_on_outbound_write`, `cancelling_a_stalled_spawned_worker_reaps_its_process`. **Restart and version negotiation are not in this run** |
| accepted differences stay visible and the worker never becomes a second kernel | same | ✓ `worker_call_passes_runtime_authorization`, `worker_ask_denial_surfaces_as_a_denied_answer`, `changed_worker_asks_require_a_new_answer`, `repeated_worker_asks_require_a_new_answer` |

## EXT-04 — MCP OAuth, issuer and connection management

| criterion | command | observed |
| --- | --- | --- |
| CIMD, pre-registration, dynamic registration and the manual path are negotiated by support | `cargo test --test mcp` | **not accepted**: the 23 cases cover disclosure, timeouts, approvals, catalogue identity and refresh; none exercises the OAuth paths that `src/mcp.rs` carries (`oauth`, issuer, credential reuse) |
| the callback validates the issuer, and reuse and isolation follow the authorisation server | same | **not accepted**: no OAuth case in the run |
| a real client logs in, starts/stops, cancels a tool and restores the connection | same | partial: start, stop, cancel and restore ✓ (`configured_child_is_initialized_and_reaped_at_shutdown`, `cancellation_after_dispatch_does_not_replay`, `list_changed_notification_refreshes_catalog_without_reconnect`, `failed_refresh_keeps_previous_catalog_until_next_change`); **no login** |

## EXT-05 — hooks that are observable, manageable and bounded

| criterion | command | observed |
| --- | --- | --- |
| lifecycle events, source, state and the most recent failure are shown | `cargo test --test hooks` | partial: `after_hook_failures_are_observed_but_never_change_results` and `failing_or_slow_before_hooks_block_dispatch_without_side_effects` pin the failure surface; **showing source and state in the TUI is not measured here** |
| unmanaged hooks can be disabled and the effective configuration identified | same | ✓ `a_disabled_hook_never_runs`, `hook_configuration_is_bounded_and_unambiguous`, `a_hook_without_the_enabled_field_still_runs` |
| timeouts and failures are never silently swallowed, and their execution and cost count toward the task cost | same | **not accepted**: failures are observed and blocking is pinned, but no case accounts hook time or cost |

## EXT-06 — custom providers and the extension SDK

| criterion | command | observed |
| --- | --- | --- |
| real needs decide whether provider plugins register and which authentication types are arbitrary | `cargo test --test provider` | 11 passed over the native adapters (`real_http_adapter_decodes_stream_and_usage`, `anthropic_prompt_cache_marks_the_stable_prefix_and_honours_max_tokens`, `openai_chat_tolerates_explicit_null_delta_fields`, `sse_framing_handles_bytewise_utf8_crlf_and_multiline_json`). **No provider-plugin registration case** |
| the version boundary between the plugin API and the Rust external protocol is explicit | — | **not accepted**: ADR-12 states the boundary, but no case pins the negotiated protocol version |
| a sample extension registers and is called without importing internal core modules | `cargo test --test worker` | ✓ `worker_lists_and_calls_a_tool` drives a real subprocess over the documented frames |

## EXT-07 — LSP and formatter lifecycle and configuration

| criterion | command | observed |
| --- | --- | --- |
| native configuration covers language matching, start command, environment, root directory and formatter | `cargo test --test lsp --test formatter` | 7 (+1 ignored) and 2 passed: `lsp_tools_query_a_language_server`, `lsp_tools_are_absent_without_a_registry`, `lsp_query_rejects_missing_positions_and_foreign_parameters`, `formatters_run_after_write_edit_and_patch_and_report_final_fingerprint` |
| real-server diagnostics, hover/definition/references and formatting are cancellable and consistent with the file version | same | **partially, not accepted as written**: the cases run against an in-process fake server (`fake_server` in `tests/lsp.rs`); `edited_documents_refresh_diagnostics_and_queries_without_reopening` pins version-consistent refresh, but on that fake only |
| a failure is isolated, a restart does not block input, and an empty diagnostic list never stands in for a completed check | same | partial: `formatter_timeout_preserves_committed_mutation_and_final_hash` pins the timeout path and keeps the committed mutation; `lsp_tools_are_absent_without_a_registry` pins absence instead of an empty answer. **Restart isolation is not in this run** |

## Still unaccepted after this record

- CFG-02: the four-scope enumeration, and the unknown-key message inside the explain output.
- CFG-03: an active turn across a reload; the agents section (reported unsupported, #2457).
- MOD-05: the "next attempt is due" projection, and cancelling between attempts.
- EXT-01: restart and protocol-version negotiation cases.
- EXT-04: every OAuth path, and a real client login.
- EXT-05: showing hook source and state in the TUI, and hook time/cost accounting.
- EXT-06: provider-plugin registration and the pinned protocol version.
- EXT-07: a real language server, and restart isolation.

Each of these is a named gap, not a completion claim. The items stay open until the rows
above are ✓ or the gap is closed by its own change.
