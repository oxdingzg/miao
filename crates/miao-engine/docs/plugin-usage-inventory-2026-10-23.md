# Product plugin/workflow inventory — 2026-10-23

Closes switch-plan G6: an inventory of the plugins and workflows actually in
use, read from the owner's live configuration and the release-channel store
(`~/.local/share/miao/miao.db`, 841 sessions, ~20.5k tool dispatches).

## Custom plugins

None. `~/.config/miao/plugin/` does not exist, no workspace carries a
`.miao/plugin` or `.opencode/plugin` directory, and the release config has no
`plugin` key. The plugin surfaces (custom tool files, `tool.definition`,
`before`/`after` hooks, plugin providers) are exercised by the automated
corpora (`packages/miao/test/engine/plugin-tools.test.ts` and the differential
suites), not by daily traffic.

## MCP servers

None configured on the release channel (`miao.jsonc` has no `mcp` key). The
OAuth ladder (CIMD ordering, RFC 9207 `iss` validation, issuer-keyed grants)
is covered by `packages/core/test/mcp/*` against the embedded fixture servers.

## Configured non-tool surfaces

- **LSP**: configured in `miao.jsonc` (source-side manifests are generated
  from product config into the native manifest — the daily path).
- **Providers**: `provider`/`model` keys with explicit routes; no AI-SDK-only
  plugin providers in daily use (the #1263 host-gateway path is test-covered).

## Workflow / product-tool traffic (release store)

| tool                  | calls |
| --------------------- | ----- |
| send_message          | 99    |
| list_sessions         | 26    |
| read_session_context  | 23    |
| enter_worktree        | 23    |
| exit_worktree         | 17    |
| task (delegation)     | 17    |
| question              | 8     |
| push_notification     | 2     |

Delegation rows in `session_delegation`: 50. The remaining traffic is engine
built-ins (`bash` ~15.8k, `read` ~0.9k, `edit` ~0.9k, `todowrite`, `monitor`,
`write`, `apply_patch`, `grep`, `glob`, `webfetch`, `job_wait`, `websearch`,
`goal`), which is the surface the G5/G6 efficiency batches measure.

## Conclusion

Every plugin/workflow surface that daily use touches — the product-tool
bridge (`send_message`, `list_sessions`, `read_session_context`,
`push_notification`), worktree, delegation `workflow`/`report`, and the
question path — is wired through the native engine and covered by the
switch-plan G6 rows. No untested-in-traffic plugin surface remains.
