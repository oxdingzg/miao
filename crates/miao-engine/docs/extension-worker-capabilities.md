# Extension worker capability matrix

What a TypeScript extension can and cannot do through the out-of-process worker
boundary. The transport, handshake and governance are fixed by
[ADR-12](adr/0012-extension-worker-interface.md); this page records the surface
as it is implemented, so a reader can tell which interfaces exist without
reading `src/worker.rs`.

Status of each row is one of:

- **implemented** — the engine calls or answers it, and tests cover it.
- **not exposed** — the interface exists in the TypeScript product path but has
  no worker equivalent; a worker cannot reach it.
- **rejected** — the engine refuses it deliberately, with the reason recorded.

## Methods

The worker speaks newline-delimited JSON over stdio. Both directions use an
`id` plus `method`; a reply echoes the `id` with `result` or `error`.

### Engine → worker

| method | params | reply | status |
| --- | --- | --- | --- |
| `hello` | `{protocol, workspace}` | `{protocol}` | implemented — handshake; a mismatched `protocol` fails the launch (`worker.rs` `PROTOCOL`) |
| `tool.list` | `{}` | `{tools: [...]}` | implemented — bounded at 64 KiB; an oversized catalog fails the launch |
| `tool.call` | `{name, input}` | tool result | implemented — dispatched only for tools the catalog declared |
| `cancel` | `{id}` | — | implemented — aborts the in-flight `tool.call` by its request id |
| `shutdown` | — | — | implemented — sent on engine teardown; the worker is not reused after it |

### Worker → engine

| method | params | reply | status |
| --- | --- | --- | --- |
| `ask` | permission question | answer, or `{error}` | implemented (protocol 2) — relayed to the Session's durable question flow; the answer rides back as the reply to the worker's own request id |

`ask` is the only reverse call. A worker cannot start a turn, read the
transcript, or reach another Session — deliberately: it is a tool provider, not
a second engine.

## Interfaces with no worker equivalent

These exist where a TypeScript plugin runs in-process. A worker does not get
them, and the reason is the same each time: they would require the worker to see
state the engine keeps out of a tool provider's reach.

| interface | where it exists | status | why not exposed |
| --- | --- | --- | --- |
| `tool.execute.before` / `after` hooks on **native built-in** tools | TypeScript plugin host | **not exposed** | The `hook_tool` reverse dispatch was removed in #2316; the client handler was dead code and has been deleted. Plugin hooks apply to plugin-provided tools only. |
| `tool.definition` on native tools | TypeScript plugin host | **not exposed** | Same removal. A worker's own `tool.list` declaration is the equivalent surface. |
| Provider plugins (`ProviderHook`, `AuthHook`) | TypeScript plugin host | **not exposed** | Provider routing is engine-owned; a worker that could register a provider would be a second engine. Custom providers go through configuration and the route catalog instead. |
| UI host slots (`TuiHostSlotMap`) | TypeScript TUI | **not exposed** | A worker has no display. UI extension is a TUI-package concern. |
| Workflow / delegation control | engine products | **not exposed** | Delegation is a product tool the model calls; a worker cannot drive it. |
| Session events / transcript | engine ledger | **not exposed** | A worker sees one `tool.call` at a time. |

## Governance

| property | value | where |
| --- | --- | --- |
| launch | engine spawns the worker; the path is host configuration, outside the model-writable workspace | `--worker-config` |
| protocol revision | `2` | `worker.rs` `PROTOCOL` |
| handshake timeout | 15 s; a timeout fails the launch | `worker.rs` `HANDSHAKE_TIMEOUT` |
| catalog bound | 64 KiB | `worker.rs:241` |
| cancellation | per-call, by request id | `cancel` |
| failure | a failed worker degrades to unavailable; the engine does not retry it into a second process | `worker.rs` `available` |
| restart | **not implemented** — once unavailable the worker stays so for the process lifetime | see below |

The restart gap is the one place this interface is weaker than the TypeScript
product path: a worker that crashes or times out is not respawned, so its tools
stay unavailable until the engine restarts. Recorded here rather than fixed,
because a supervising restart loop is a design change (how many attempts, what
backoff, whether a crashing worker should be quarantined) and not a defect.

## Tests

| behaviour | test |
| --- | --- |
| a declared tool is listed and called | `crates/miao-engine/tests/worker.rs` |
| a timeout degrades the worker without leaving a reusable partial transport | same file |
| cancellation interrupts a call blocked on outbound write | same file |
| a missing optional worker does not prevent engine admission | same file |
| a native worker tool round-trips through a Session | `packages/miao/test/engine/native-worker-tools.test.ts` |
