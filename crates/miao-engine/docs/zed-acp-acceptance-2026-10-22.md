# Zed (ACP) acceptance — 2026-10-22

The first third-party ACP editor pass: Zed 1.20.2 (stable) driving a real
`miao-engine acp` process over stdio, with real billed model traffic
(DeepSeek's official OpenAI-compatible endpoint) rather than a fixture
provider. A recording stdio proxy between Zed and the engine captured every
JSON-RPC frame, so each claim below is backed by the recorded exchange.

## Observed outcomes

| Boundary | Scenario | Result and oracle |
| --- | --- | --- |
| Zed ↔ engine | Connect and initialize | Zed sends `initialize` with its client caps; the engine answers protocol 1 with `agentInfo` and an `miao-login` auth method. |
| Zed ↔ engine | New thread | `session/new` returns a product session id; the thread renders in the agent panel. |
| Zed ↔ engine | Prompt with real traffic | `session/prompt` reaches DeepSeek through the engine and settles with `stopReason: end_turn`; assistant text renders in Zed. Usage rows record real billed cost and cache reads (one turn surfaced 647,808 cache-read tokens). |
| Zed ↔ engine | Reopen a thread | `session/load` replays the committed conversation as `user_message_chunk` updates with no duplicated assistant output. |
| Zed ↔ engine | Failed turn diagnosability | A deliberately invalid model id now reports `invalid request: provider HTTP 400` in the panel instead of the generic `session execution failed`. |

## Bugs found and fixed by this acceptance

- `acp --model provider/id` passed the hosted id verbatim into the provider
  request body (`HTTP 400`); the split now mirrors serve-mode route
  resolution (#1225).
- A failed run discarded its recorded `stop_failure` message and reported a
  bare `session execution failed`; the ACP error now carries the cause
  (#1225).

## Reproducing the Zed setup

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "miao": {
      "type": "custom",
      "command": "/absolute/path/to/miao-engine",
      "args": [
        "acp",
        "--db", "/absolute/path/to/acp.db",
        "--workspace", ".",
        "--model", "<transport-model-id>",
        "--provider", "openai-chat",
        "--endpoint", "<ProviderBase>/v1/chat/completions"
      ]
    }
  }
}
```

`acp` reads credentials from the environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), so wrap the command in a small
launcher that exports the key when Zed cannot pass env directly. It defaults to
the workspace mode (reads allow, writes ask through the editor's permission
dialog); pass `--mode read-only` for a browse-only agent. Supply the
transport's bare model id here: the product's `provider/model` form is a
host-side route name, not a wire model id.

## Status

Zed is verified as a third-party ACP client on this build. Slow-client
backlog bounds and multi-editor coverage remain design-level checks; the
product-shell transcript retype is tracked separately.
