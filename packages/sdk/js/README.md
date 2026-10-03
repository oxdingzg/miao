# @miao/sdk

Compatibility JavaScript SDK for miao. This repository owns its source and generates its client from miao's API.

For new integrations, prefer `@miao/client`:

```ts
import { OpenCode } from "@miao/client"

const client = OpenCode.make({ baseUrl: "http://127.0.0.1:4096" })
const sessions = await client.sessions.list()
```

`@miao/client` returns endpoint results directly and throws `ClientError` on failure. The compatibility SDK remains available for consumers that use the older grouped methods, `{ data, error }` results, or rendering types. It is not a drop-in replacement for `@miao/client`.

## Compatibility entry points

- `@miao/sdk/v2`: client, server launch helpers, and types.
- `@miao/sdk/v2/client`: client and types without process launch helpers.
- `@miao/sdk/v2/types`: generated API types.
- `@miao/sdk/v2/server`: local server and TUI launch helpers.

```ts
import { createMiaoClient } from "@miao/sdk/v2/client"

const client = createMiaoClient({ baseUrl: "http://127.0.0.1:4096" })
const result = await client.v2.session.list()
```

## Renamed exports

When migrating an existing dependency from `@opencode-ai/sdk` to `@miao/sdk`, update the imports and these exported names:

| Previous name | miao name |
| --- | --- |
| `createOpencodeClient` | `createMiaoClient` |
| `OpencodeClient` | `MiaoClient` |
| `OpencodeClientConfig` | `MiaoClientConfig` |
| `createOpencodeServer` | `createMiaoServer` |
| `createOpencodeTui` | `createMiaoTui` |
| `createOpencode` | `createMiao` |

Server and TUI helpers launch the `miao` executable from PATH.

Regenerate the compatibility SDK from the repository root with `./packages/sdk/js/script/build.ts`. Generate the current client from `packages/client` with `bun run generate`.

See [LICENSE](../../../LICENSE).
