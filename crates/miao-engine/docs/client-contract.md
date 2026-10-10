# Client contract surface (migration scope)

What the product shell consumes, enumerated so a façade (ADR-11) can be scoped
handler by handler. Counts are a snapshot of `packages/protocol/src/groups` and
may drift; re-run the count if it matters.

## Endpoint counts by group (≈124 total, 29 groups)

| Group | Endpoints | Group | Endpoints |
|---|---|---|---|
| session | 32 | project-copy | 3 |
| runtime | 11 | vcs | 3 |
| pty | 9 | worktree | 3 |
| permission | 7 | credential | 2 |
| workspace | 7 | location | 2 |
| integration | 7 | model | 2 |
| mcp | 6 | provider | 2 |
| project | 5 | agent, capabilities, command, config, control-plane, event, formatter, fs, health, lsp, message, question, reference, skill | 1–4 each |

## Streaming

- The event group defines an event stream the shell subscribes to; the shell
  registers handlers such as `event.on("tui.session.select", …)` and reads session
  projections through the typed client (`sync.session.get`, `api.state.session.*`).
- The engine's equivalent is the durable `event` cursor plus ephemeral
  `progress` (stdio/HTTP-SSE). The façade bridges product events onto engine
  events; the committed cursor keeps replay→live gapless (ADR-03/ADR-07).

## Consumption pattern

- The shell uses the client generated from the schema
  (`packages/client/src/generated`), not hand-written HTTP calls. The server
  implements the same schema under `packages/server/src/handlers`.

## Migration implication

- Because the client is generated, the cheapest way to keep the shell is to keep
  the HttpApi and reimplement the **handler bodies** as engine calls (ADR-11
  "engine core + façade"), not to reimplement the routes in the engine.
- Scope concentrates in the behaviour-bearing groups — `session` (32), `runtime`
  (11), `pty` (9), `permission` (7), `integration` (7) — where a handler carries
  real session/permission/process behaviour rather than a projection read.
