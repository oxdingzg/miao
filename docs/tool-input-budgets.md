# Tool argument generation budgets

The Session runner bounds unfinished tool arguments to stop an oversized or stalled provider response before a local tool is dispatched.

| Environment variable         | Default   | Meaning                                                         |
| ---------------------------- | --------- | --------------------------------------------------------------- |
| `MIAO_TOOL_INPUT_MAX_BYTES`  | `1048576` | Maximum UTF-8 bytes for one tool call's arguments.              |
| `MIAO_TOOL_INPUT_TIMEOUT_MS` | `120000`  | Maximum inactivity while waiting for one call's argument bytes. |

Set these variables before starting miao. Values must be positive finite numbers; invalid values use the defaults. For deliberately large file writes, raise the byte budget, for example:

```sh
MIAO_TOOL_INPUT_MAX_BYTES=8388608 miao
```

The idle deadline starts when a call starts and resets only when non-empty argument fragments arrive for that same call. An actively generated document may take longer than two minutes overall. Empty fragments, duplicate start events, unrelated text/reasoning, network keep-alives, and other calls do not extend an unfinished call's deadline. The byte limit remains cumulative across all fragments.

The idle deadline applies even if no further events arrive. It stops once the arguments finish, so a long-running bash command is governed by the command's own timeout rather than this generation deadline. Ordinary text answers are not subject to these tool-specific limits.

A budget violation cancels the provider stream and terminates the turn without automatically retrying it. Completed local tool results remain durable. Incomplete local calls have not been dispatched; provider-managed operations may have unknown outcomes and must not be blindly replayed.

Diagnostics report the call identity, byte count, elapsed time, time since the last argument progress, and applicable limits. They do not include raw argument content. The guard uses deterministic budgets rather than repetition heuristics so intentionally repetitive source code can still be written within the configured limits.
