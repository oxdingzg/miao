# Handler migration blueprint (B1: engine core + product façade)

Construction plan for [ADR-11](adr/0011-client-contract.md) B1: keep the product
HttpApi, generated client and shell; move the **agent-execution** groups to the
engine and leave the **product/host** groups in place. Enumerated from
`packages/server/src/handlers` (`handlers.handle("<group>.<op>")`), ~120 ops;
counts are a snapshot.

## The split

The engine models agent execution (sessions, turns, tools, permissions,
questions, MCP client, LSP core, filesystem tools). It does **not** model the
product's repo/workspace/config/catalog/auth/remote-control concerns. So the B1
façade delegates execution groups to the engine and serves the rest from the
existing host.

| Group | Ops | Class | Engine counterpart / host reason | Evidence (core import) |
|---|---|---|---|---|
| session | 32 | engine | full session command table (`admit`/`events`/`history`/`fork`/`compact`/`recall`/`state`/…); `session.diff`/`todo`/`context` are projection/state reads | `session`, `session/usage-store` |
| message | 1 | engine | `session.history` | `session`, `session/message` |
| event | stream | bridge | durable cursor + ephemeral `progress` (ADR-03/07) | `event` |
| permission | 7 | engine | approval binding (ADR-04) | `permission`, `permission/saved` |
| question | 4 | engine | question lifecycle | `question` |
| fs | 3 | engine | `read_file`/`list_files`/`glob`/`grep` | `filesystem`, `schema` |
| lsp | 1 | engine | LSP core (status is the surface) | `lsp` |
| runtime | 11 | split | `identity`/`stop` → engine; `control.*` is product remote-control → host | `runtime/identity` |
| mcp | 6 | split | engine MCP client (`status`/`resources`); `connect`/`logout`/`authenticate` → host auth | `mcp` |
| pty | 7 | split | engine has pty-backed process; the terminal multiplex/ticket API → host | `pty`, `pty/protocol`, `pty/ticket` |
| config | 4 | host | product config + catalogs | `config`, `config/write` |
| integration | 7 | host | product auth (key/oauth attempts) | `integration` |
| credential | 2 | host | product credential store (engine reads only, ADR-09) | `integration` |
| location | 2 | host | product location | `global`, `location` |
| project | 5 | host | repo/project registry | `project`, `project/registry` |
| project-copy | 3 | host | git + location copy | `git`, `project/copy` |
| workspace | 7 | host | workspace registry | `workspace` |
| worktree | 3 | host | git worktree | `project/worktree` |
| vcs | 3 | host | git diff/status | `git`, `vcs-diff` |
| control-plane | 1 | host | remote-control move-session | `control-plane/move-session` |
| agent / command / skill / reference | 1 each | host | catalogs | `agent`/`command`/`skill`/`reference` |
| model / provider | 2 each | host | catalogs | — |
| formatter | 1 | host | formatter | `format` |
| health | 1 | host | build/version | `installation/version` |
| capabilities | 1 | host | capability flags | — |

## Engine gap (must stay host, or be added to the engine later)

Repo/git/workspace/worktree/vcs/project, config + catalogs
(agent/command/skill/reference/model/provider/formatter/capabilities), product
auth (integration/credential), remote-control (control-plane + `runtime.control`),
the pty terminal API, and location. B1 does **not** move these; a TypeScript-free
product (ADR-08 M4c) would additionally have to move or rewrite them.

## One-shot cutover

1. **Bridge the event stream** (`event.*`) onto the engine's durable cursor.
2. **Move execution groups** to the engine: `session`, `message`, `permission`,
   `question`, `fs`, `lsp`; and the engine halves of `runtime` and `mcp`. Keep
   the host halves.
3. **Repoint** only the handlers for those groups to engine calls; the HttpApi,
   generated client and shell are unchanged.
4. **Cut over in one release** (one-shot), with the prerequisites already in
   place: single session-core owner per Session (ADR-08), single credential owner
   (ADR-09), and the extension worker for custom tools (ADR-10).
5. **Keep the host** for the gap groups; they are not part of the swap.

Net effect: the engine becomes the agent core for the product's execution
surface while the shell and the product/host groups are untouched — the smallest
one-shot replacement that keeps the shell working.
