import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentV2 } from "@miao/core/agent"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionStore } from "@miao/core/session/store"
import { ToolPlugins } from "@miao/core/tool/plugins"
import { Cause, Effect, Exit, Option } from "effect"
import { ToolFailure } from "@miao/llm"
import { EngineError, type EngineOptions } from "./client"

/**
 * Host side of the plugin tool-hook reverse bridge: the engine learns only
 * which hook families have registered callbacks; the callbacks themselves stay
 * in-process and are answered around marked native tool calls, in registration
 * order, with the same verdicts a TypeScript Session produces.
 */
export const prepare = Effect.fn("Engine.pluginHooks")(function* (
  configuration: Omit<EngineOptions, "db" | "workspace">,
  input: { store: SessionStore.Interface },
) {
  const options: Partial<EngineOptions> = {}
  if (configuration.pluginHooksFile) return options
  const plugins = Option.getOrUndefined(yield* Effect.serviceOption(ToolPlugins.Service))
  if (!plugins) return options
  const marker = {
    before: plugins.has("before"),
    after: plugins.has("after"),
    definition: plugins.has("definition"),
  }
  if (!marker.before && !marker.after && !marker.definition) return options
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-plugin-hooks-")),
      catch: () => new EngineError("engine_plugin_hooks_io", "could not create native plugin-hooks directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "plugin-hooks.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, JSON.stringify(marker), { mode: 0o600 }),
    catch: () => new EngineError("engine_plugin_hooks_io", "could not write native plugin-hooks marker"),
  })
  options.pluginHooksFile = file
  options.onHookTool = (call) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(call.sessionID)
        const session = yield* input.store.get(sessionID)
        const agent = session?.agent ?? AgentV2.defaultID
        if (call.kind === "definition") {
          // The definition family mutates the event in place and never fails:
          // a broken hook is logged and skipped, the tool stays advertised.
          const raw = (call.definition ?? {}) as { description?: unknown; input_schema?: unknown }
          const event = {
            tool: call.tool,
            description: typeof raw.description === "string" ? raw.description : "",
            parameters: raw.input_schema ?? {},
          }
          yield* plugins.runDefinition(event).pipe(Effect.exit)
          return {
            definition: { name: call.tool, description: event.description, input_schema: event.parameters },
          }
        }
        if (call.kind === "before") {
          const event = { tool: call.tool, sessionID, callID: call.callID, agent, args: call.args }
          const exit = yield* plugins.runBefore(event).pipe(Effect.exit)
          if (Exit.isFailure(exit)) return { deny: denyMessage(exit.cause) }
          return { args: exit.value.args }
        }
        const value = call.output ?? null
        const event = {
          tool: call.tool,
          sessionID,
          callID: call.callID,
          agent,
          args: call.args,
          title: "",
          output: typeof value === "string" ? value : JSON.stringify(value),
          metadata: value,
        }
        const originalOutput = event.output
        const originalMetadata = event.metadata
        const exit = yield* plugins.runAfter(event).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return { deny: denyMessage(exit.cause) }
        if (exit.value.output === originalOutput && exit.value.metadata === originalMetadata) return {}
        return { output: exit.value.metadata !== originalMetadata ? exit.value.metadata : exit.value.output }
      }),
    )
  return options
})

const denyMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return failure instanceof ToolFailure ? failure.message : String(failure)
}

export * as PluginHooks from "./plugin-hooks"
