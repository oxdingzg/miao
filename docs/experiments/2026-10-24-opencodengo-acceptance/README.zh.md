# Gemini/Anthropic live acceptance — 2026-10-24 (partial, blocker documented)

Native-engine live acceptance over real Gemini and Claude models via the
user's own credentials (rust placement, `miao run`, 7-scenario conformance
battery per arm).

## Gemini leg — verified

`commandcode/google/gemini-3.8-flash` (user's active commandcode
subscription) through the native engine:

| scenario | status |
| --- | --- |
| tool-recall | PASS |
| file-edit | PASS |
| multi-turn-retention | PASS |
| apply-patch | FAIL (model spun 25 turns on the patch format — model behavior, engine events healthy) |
| background-job | FAIL (no background events — under investigation) |
| session-title | FAIL (no sessionID in events — under investigation) |
| usage-priced | SKIP (scenario pinned to another model) |

Raw transcripts in `raw/`.

## Anthropic leg — blocked, two documented blockages

1. `commandcode/claude-sonnet-5-5` → **HTTP 400 insufficient credits**: the
   user's commandcode balance is exhausted.
2. `opencode-go/claude-haiku-5-5` → **HTTP 400 "Model does not support this
   protocol"** via the gateway's openai-chat endpoint; the workspace privacy
   gate was already lifted by the user (the earlier training-policy 400 is
   gone), so the remaining question is the gateway's anthropic-protocol
   endpoint for claude models (`/anthropic/v1/messages`-style path needs
   confirmation from the opencode-go docs or the user's opencode client
   config) plus a routes-file entry with `provider: "anthropic"`.

`opencode-go/gemini-4-argon-contributor` additionally requires the
contributor privacy tier (now enabled) AND a non-openai-chat protocol —
same class of gateway limitation, kept out of scope after the user enabled
the privacy setting.

## Route-file changes made on this machine (private config, not repo)

- Added routes `opencode-go/gemini-4-argon-contributor`,
  `opencode-go/claude-haiku-5-5` (endpoint + database credential cloned from
  the working `opencode-go/deepseek-v4.1-flash` entry) and
  `auth.headers: {"x-opencode-session": "$session"}` — the session header is
  required by the gateway (product-routes injects it only for catalog routes).
- `commandcode/claude-sonnet-5-5` provider fixed to `anthropic` with the
  `/provider/v1/messages` endpoint (the gateway rejects anthropic models on
  `/chat/completions`).

Backup: `model-routes.json.bak`.

## Update 2026-10-25 — the Anthropic route is confirmed on the catalog path

Blockage 2 above is settled as a routing question. The catalog entry for
`opencode-go/claude-haiku-5-5` carries a model-level
`provider.npm = @ai-sdk/anthropic` with `api =
https://opencode.ai/inference/go/anthropic/v1`, so `ProductRoutes.profile()`
already selects the `anthropic` wire. The hand-written route entry this record
described is no longer needed for that model.

Evidence from the released 0.3.5 binary with the user's global config
(`engine.storage` set), `--engine native -m opencode-go/claude-haiku-5-5`
(`raw/anthropic-native-2026-10-25.jsonl`):

- The first provider turn completed — `step_finish` with reason `tool-calls`,
  21,145 input tokens — and the `read` tool executed with call id
  `toolu_015Fbv4AURbfKCGb98uXDtgW`, an Anthropic-style id, returning the
  file's sha256 and text.
- The continuation was refused with HTTP 429 `GoUsageLimitError`,
  `limitName: "weekly"` (`Go usage limit exceeded`). Direct probes of both
  `/inference/go/anthropic/v1/messages` (catalog) and `/zen/go/v1/messages`
  (claude-oc) reach the model and answer with Anthropic-shaped errors, so the
  remaining blocker is the workspace's weekly quota, not the protocol.

What this does and does not establish: the route, the wire format and the
native tool loop are verified end to end for one turn. A daily multi-turn
session is still unverified, and nothing here claims it.
