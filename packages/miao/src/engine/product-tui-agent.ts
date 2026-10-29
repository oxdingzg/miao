export * as ProductTuiAgent from "./product-tui-agent"

import { AgentV2 } from "@miao/core/agent"
import { Effect, Option, Schema } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EngineError, type EngineOptions } from "./client"
import { capabilities } from "./discovery"
import { agentManifest } from "./product-agent"

const Routes = Schema.Array(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    provider: Schema.String,
    model: Schema.String,
    variants: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  }),
)

// The native provider identity used by Session model bindings.
const protocol = (provider: string) => {
  if (provider === "anthropic") return "anthropic-messages"
  if (provider === "gemini") return "gemini-generate-content"
  if (provider === "amazon-bedrock") return "bedrock-converse"
  if (provider === "subscription-responses") return "openai-responses"
  return provider
}

/** Capture data; the engine owns selection, policy evaluation and execution. */
export const prepare = Effect.fn("ProductTuiAgent.prepare")(function* (
  options: Pick<EngineOptions, "binary" | "model" | "provider" | "modelRoutesConfigFile">,
) {
  if (capabilities(options.binary)?.sessionAgentDefaults !== 1)
    return yield* Effect.fail(
      new EngineError("engine_agent_defaults_unavailable", "Native TUI requires default-agent capture support"),
    )
  const agents = yield* AgentV2.Service
  const agent = yield* agents.default()
  if (!agent) return yield* Effect.fail(new EngineError("engine_agent_missing", "No default agent is configured"))
  const routes = options.modelRoutesConfigFile
    ? yield* Effect.tryPromise({
        try: async (): Promise<unknown> => Bun.file(options.modelRoutesConfigFile!).json(),
        catch: () => new EngineError("engine_agent_routes", "Could not read the prepared agent model routes"),
      }).pipe(
        Effect.flatMap((value) => {
          const decoded = Schema.decodeUnknownOption(Routes)(value)
          return Option.isSome(decoded)
            ? Effect.succeed(
                decoded.value.map((route) => ({
                  route_id: route.id ?? null,
                  protocol: protocol(route.provider),
                  model: route.model,
                  variants: route.variants?.map((variant) => variant.id),
                })),
              )
            : Effect.fail(new EngineError("engine_agent_routes", "Invalid prepared agent model routes"))
        }),
      )
    : [{ route_id: null, protocol: protocol(options.provider ?? "anthropic"), model: options.model }]
  const manifest = yield* Effect.try({
    try: () => JSON.stringify(agentManifest(agent, routes)),
    catch: () => new EngineError("engine_agent_model", "The default agent model is not in the prepared native routes"),
  })
  if (Buffer.byteLength(manifest) > 4 * 1024 * 1024)
    return yield* Effect.fail(new EngineError("engine_agent_limit", "Default agent manifest exceeds 4 MiB"))
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-tui-agent-")),
      catch: () => new EngineError("engine_agent_io", "Could not create the default agent manifest"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "agent.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, manifest, { mode: 0o600 }),
    catch: () => new EngineError("engine_agent_io", "Could not write the default agent manifest"),
  })
  return { agentConfigFile: file }
})
