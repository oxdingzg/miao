# OpenCode V2 Effect Plugin API

The Effect plugin API grants plugins two in-process capabilities:

- `hook` installs behavior at an OpenCode extension point.
- `reload` reruns every transform hook for a stateful domain.

The public server client will be exposed separately. It is intentionally not part of `PluginContext` yet.

## Defining A Plugin

```ts
import { define } from "@miao/plugin/v2/effect"
import { Effect } from "effect"

export const Plugin = define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  }),
})
```

Plugin setup registers hooks imperatively. It does not return a hook object.

Configuration supplied for the plugin is available as `ctx.options`.

Registrations are owned by the plugin scope. Closing the scope removes them automatically; a registration may also be removed early through `dispose`.

## Transform Hooks

Transform hooks contribute to stateful domains:

```ts
yield *
  ctx.agent.transform((agent) => {
    agent.update("reviewer", (item) => {
      item.description = "Reviews code for regressions"
      item.mode = "subagent"
    })
  })
```

OpenCode rebuilds the domain when a transform is registered or disposed. A rebuild starts from fresh domain state and runs every active transform in registration order.

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.catalog.transform
ctx.command.transform
ctx.integration.transform
ctx.reference.transform
ctx.skill.transform
```

## Runtime Hooks

Runtime hooks intercept live operations rather than rebuilding domain state:

```ts
yield *
  ctx.aisdk.sdk(
    Effect.fn(function* (event) {
      if (event.package !== "@ai-sdk/xai") return
      const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
      event.sdk = mod.createXai(event.options)
    }),
  )

yield *
  ctx.aisdk.language((event) => {
    if (event.model.providerID !== "xai") return
    event.language = event.sdk.responses(event.model.api.id)
  })
```

Hooks run sequentially in registration order. Later hooks observe mutations made by earlier hooks.

## Tool Hooks

`ctx.tool` is the V2 replacement for the legacy `tool.execute.before`, `tool.execute.after`, `tool.definition` and `tool` entries of `Hooks`:

```ts
// Rewrite or reject a call. Failing (or throwing) rejects it with a model-visible error.
yield *
  ctx.tool.before((event) => {
    if (event.tool === "read" && String(event.args.filePath).endsWith(".env"))
      return Effect.fail(new Error("Reading .env files is not allowed"))
    event.args = { ...event.args }
  })

// Rewrite the model-facing text (`output`) or structured result (`metadata`) of a successful call.
yield *
  ctx.tool.after((event) => {
    event.output = event.output.replaceAll(process.env.SECRET ?? "", "[redacted]")
  })

// Rewrite the description or input JSON Schema the model sees.
yield *
  ctx.tool.definition((event) => {
    if (event.tool === "bash") event.description += "\nNever run `rm -rf /`."
  })

// Register `tool({ ... })` definitions from `@miao/plugin/tool`.
yield * ctx.tool.register({ "my-tool": myTool })
```

Events carry `tool`, `sessionID`, `callID` and `agent`. A failing `before`/`after` hook settles the call as a tool error; it never fails the session. A failing `definition` hook is logged and skipped. Registered tools go through the same permission checks as built-ins: every call asks `PermissionV2` under the tool name, and `context.ask(...)` inside the tool maps to the same check.

## Legacy `Hooks` Plugins

Plugins written against the V1 `Hooks` API (a function returning hooks, exported from `@miao/plugin`) are deprecated. V2 sessions do not load them and none of their hooks run; configuring one logs a single warning. V2 supports the domains listed above (`agent`, `aisdk`, `catalog`, `command`, `integration`, `reference`, `skill`) plus `tool`. Custom tool files in `{tool,tools}/*.{js,ts}` keep working unchanged.

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
let data = yield * loadCatalog()

yield *
  ctx.catalog.transform((catalog) => {
    applyCatalog(data, catalog)
  })

data = yield * loadCatalog()
yield * ctx.catalog.reload()
```

Reload belongs to the domain, not an individual registration. `ctx.catalog.reload()` reruns every active catalog transform and publishes the rebuilt catalog.

Available reload operations are:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```
