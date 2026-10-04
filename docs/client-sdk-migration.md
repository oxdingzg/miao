# Client and scoped SDK migration

miao's network API is generated from the public HttpApi in `packages/client`. The former Hey API SDK and its `@miao/sdk/v2` entrypoints have been retired.

## Network clients

Use `@miao/client` for Promise callers and `@miao/client/effect` for Effect callers.

```ts
import { OpenCode } from "@miao/client"

const client = OpenCode.make({ baseUrl: "http://localhost:4096" })
const session = await client.sessions.get({ sessionID })
const page = await client.messages.list({ sessionID, limit: 20, order: "desc" })
```

The Promise client returns endpoint values directly. A Session lookup returns the Session, while a paginated lookup retains its `{ data, cursor }` domain envelope. The legacy transport envelope (`response`, `request`, `error`, and the extra `data` nesting) is gone.

Capability groups include `sessions`, `messages`, `permissions`, `questions`, `integrations`, `files`, and `projects`. Integration methods are flat (`connectKey`, `connectOauth`, `attemptStatus`, and `attemptComplete`). Session permission and question methods belong to their own groups.

Declared failures retain their tagged wire objects and have generated predicates such as `isSessionNotFoundError`. Infrastructure failures are `ClientError` instances. Error presentation must handle both; it must not assume every rejection is an `Error` subclass.

Per-call cancellation and headers go in a separate options argument:

```ts
await client.sessions.get({ sessionID }, { signal, headers })
```

`events.subscribe(...)` and `sessions.events(...)` return cold `AsyncIterable` values. Iteration opens the request. Cancellation closes the body, including an idle in-memory body. Clients do not automatically reconnect: live consumers refresh authoritative state and explicitly resubscribe; durable consumers retain the aggregate sequence for replay.

## Embedded host

`@miao/sdk` now owns the Effect-native in-process host formerly named `@miao/sdk-next`:

```ts
import { OpenCode } from "@miao/sdk"

const host = yield* OpenCode.create()
const session = yield* host.sessions.get({ sessionID })
```

Creation is scoped. The host executes the same Server router and handlers through an in-memory transport. Closing its Effect Scope releases its resources. Local-only tool registration is available through `host.tools.register(...)`.

## UI and plugins

Rendering records live in `@miao/schema/view-models`; the properties-shaped UI event projection lives in `@miao/schema/event-view`. These compatibility rendering records do not reinstate the retired V1 session runtime.

The TUI plugin `client` capability uses the Promise API above. Deprecated V1 server hooks remain deprecated; current server plugins use `@miao/plugin/v2/promise` or `@miao/plugin/v2/effect`.

Regenerate clients with `bun run generate` from `packages/client`, or run `bun script/generate.ts`. Generated files must not be edited directly.
