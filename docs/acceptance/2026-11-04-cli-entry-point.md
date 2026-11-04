# Acceptance record — the Rust CLI as the product entry point

Tree: `04dc191a01` for the binary that produced the rows below, except the `serve`, `web`
and `attach` rows, which were re-run on the binary built with `2c35372277` (#2487, `fix(cli): give
serve a ledger outside its own workspace`).

Every command was run on the macOS build host from a scratch `HOME`, `MIAO_CONFIG_DIR`
and workspace, with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` set to
`dummy` where a credential was needed, so nothing touched a real account or database.
A reviewer reproduces each row with:

```sh
export HOME=$(mktemp -d)/home MIAO_CONFIG_DIR=$(mktemp -d)/config
mkdir -p "$HOME" "$MIAO_CONFIG_DIR" && cd "$(mktemp -d)"
miao <the row's command>
echo "exit=$?"
```

## RUS-04 — every entry point, item by item

| command | observed | exit |
| --- | --- | --- |
| `miao --version` | `miao 0.3.29` | 0 |
| `miao --build-id` | a build identity (`33bfc4e4-…`), the value an installer keeps this build under | 0 |
| `miao --help` | the full surface: 50 command lines, every one of them owned by this binary | 0 |
| `miao definitely-not-a-command` | `miao: unknown command definitely-not-a-command` then the usage block | 2 |
| `miao db path` | the engine ledger and the product database path, with `(absent)` when the product one does not exist | 0 |
| `miao db stats` with no database | `miao db stats: no database at <path>` | 1 |
| `miao db backup` with no database | `miao db backup: no database at <path>` | 1 |
| `miao doctor` | `engine protocol 2 schema 25`, the database path, and `database not created yet` | 0 |
| `miao models` with no provider | `no model routes: no provider is configured in <config dir>` | 1 |
| `miao auth` without `MIAO_ENGINE_CREDENTIAL_DB` | `set MIAO_ENGINE_CREDENTIAL_DB (the product passes it to the engine)` | 1 |
| `miao plugins` | `no plugins configured — the native binary needs no JavaScript runtime` | 0 |
| `miao remote` | `not paired (no …/remote-auth.json)` | 0 |
| `miao agent list` | `no agent configuration in <config dir>` | 0 |
| `miao session list` | `no sessions` | 0 |
| `miao stats` | `sessions 0 / turns 0 / input 0` | 0 |
| `miao completion bash` | a completion line listing the command names | 0 |
| `miao debug paths` | `data`, `cache` and `state` directories | 0 |
| `miao pr` outside a repository | `miao pr: not a git repository` | 1 |
| `miao upgrade --check` | `Current version: 0.3.29`, then `miao 0.3.29 is up to date` | 0 |
| `miao run "hello"` with no credential | `API key or explicit credential source is required` | 1 |
| `miao run "hello"` with a credential | the same credential gate is passed; a real answer needs a real provider, which this record does not spend | — |
| `miao serve --port 0` (before #2487) | `invalid request: process-enabled runtime requires its database outside the workspace` — the default ledger sat beside the workspace, which the runtime refuses | 1 |
| `miao serve --port 0` (after #2487) | `miao serve listening on http://127.0.0.1:58275 token=…`, nothing written into the workspace | 0 |
| `miao attach http://127.0.0.1:58275` | `reachable (HTTP/1.1 404 Not Found)` — the probe reports reachability, not a payload | 0 |
| `miao web --port 0` | `open the interface at the address printed below` and then the same `serve` line | 0 |
| `miao acp` + one `initialize` frame | `{"id":1,"jsonrpc":"2.0","result":{"agentCapabilities":{"loadSession":true},"agentInfo":{"name":"miao-engine","version":"0.3.29"},"authMethods":[{"id":"miao-login",…}],"protocolVersion":1}}` | 0 |
| `miao acp` without a credential | `miao acp: API key or explicit credential source is required` | 1 |

## Contracts this run pins

- One binary owns every entry point: `USAGE` names 50 command lines and the unknown-command
  path exits 2 with that usage, so a script can tell "wrong command" (2) from "the command
  ran and reported a problem" (1).
- A failure names what to do: a missing database, a missing provider, a missing credential
  database and a non-repository each print the next step rather than a stack trace.
- `serve`, `web` and `acp` refuse to start without a provider credential instead of
  starting a server that cannot answer; `miao plugins` states that the native binary needs
  no JavaScript runtime, which is the RUS-05 boundary in the operator's words.
- `attach` reports reachability only. It does not attach a second UI any more.
- `acp` negotiates protocol version 1 and advertises `loadSession`.

## Not accepted for RUS-04

- **`miao config` does not exist.** The item names it, but configuration is `--config-dir`,
  `miao debug paths` and `miao doctor`; there is no `config` subcommand to accept. Either
  the item's list is corrected or the command is added.
- **The TUI row was not exercised here.** Starting it needs a terminal, so its behaviour is
  accepted (or not) by the TUI items and their PTY records, not by this matrix.
- **`miao web` promises an interface this binary does not serve.** The engine's HTTP
  surface is `/rpc`, `/events`, `/version` and `/lease`; no HTML and no assets. The
  command exits 0 and prints an address for a browser interface that has to come from the
  TypeScript app. That is recorded as a gap rather than a ✓.
- `miao auth` needs `MIAO_ENGINE_CREDENTIAL_DB` in a single-binary start; the message says
  so, but a bare `miao auth` fails on a fresh install.
