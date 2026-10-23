# Zed (ACP) UI acceptance — 2026-10-23

The human click-through that the 2026-10-22 Zed pass left open: approval,
denial, cancellation, and reconnect driven from Zed's own UI, with the engine's
ACP frames recorded by the stdio proxy.

## Setup

- Zed 1.25.2 (stable), `miao` registered as a custom agent server through
  `~/.local/share/miao/zed/zed-acp-proxy.ts`.
- `miao-engine 0.2.25`, `deepseek-flash` on DeepSeek's official
  OpenAI-compatible endpoint, real billed traffic.
- The engine runs in workspace mode: reads stay silent and workspace writes
  ask through the editor's permission dialog, which is the surface this
  acceptance exercises. The recording was taken on `miao-engine 0.2.25`, whose
  `acp` entry defaulted to `read_only` (reads silent, write/process tools not
  registered, so no prompt was possible), so it passed
  `--policy acp-policy.json` (`{"mode": "workspace"}`). #1277 makes workspace
  the `acp` default; a release carrying it needs no policy for this flow, and
  `--mode read-only|workspace` overrides either default.
- Workspace: an empty scratch directory. The recording proxy appends every
  chunk to `~/.local/share/miao/zed/acp-protocol.log`.

## Scenarios and recorded frames

| Scenario | Operator action | Recorded ACP exchange | Result |
| --- | --- | --- | --- |
| Approval | "Create notes.md in this workspace with the text hello" → **Allow once** | `session/request_permission` id 1 (`write_file notes.md`, `expected_sha256: null`) → client reply `{"outcome":{"outcome":"selected","optionId":"allow_once"}}`; the tool then writes `notes.md` | PASS |
| Denial | "Create denied.md in this workspace with the text nope" → **Reject** | `session/request_permission` id 2 (`write_file denied.md`) → client reply `reject_once`; `denied.md` is absent | PASS |
| Cancellation | long-answer prompt → **Stop** while the turn runs | client `session/cancel` notification; the matching `session/prompt` response carries `"stopReason":"cancelled"` | PASS |
| Reconnect | quit Zed, reopen, reopen the thread | a fresh agent process received `session/load`; the engine replayed `user_message_chunk` updates (28 across the recorded sessions) and the thread rendered once | PASS |

## Verifying a recording

`script/acp-ui-acceptance.ts` reads the recording and checks the four
scenarios by their frames (both ACP option vocabularies are accepted: the
TypeScript layer's `once`/`always`/`reject` and the engine's
`allow_once`/`allow_always`/`reject_once`).

```sh
bun script/acp-ui-acceptance.ts
# ACP UI ACCEPTANCE=PASS
```

## Scope

This closes the third-party-editor UI row for Zed. It does not cover a second
editor (VS Code has no native ACP client and miao ships no extension), nor
slow-client backlog bounds, which stay with the automated
`event-backpressure-http.test.ts` / `native-acp-reconnect.test.ts` evidence.
