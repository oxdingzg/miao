export * as PluginShellEnvironment from "./shell-environment"

import { ShellEnvironment } from "@miao/core/shell/environment"
import { Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "."

/**
 * Feeds plugin `shell.env` hooks into the V2 bash tool, as PluginPtyEnvironment
 * does for terminals. It provides the shared `ShellEnvironment.layer` itself,
 * so it installs into the same instance every Location's bash tool reads.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* ShellEnvironment.Service
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    yield* environment.install((input) =>
      instances.provide(
        { directory: input.directory },
        plugin
          .trigger(
            "shell.env",
            { cwd: input.cwd, sessionID: input.sessionID, callID: input.callID },
            { env: {} as Record<string, string> },
          )
          .pipe(Effect.map((result) => result.env)),
      ),
    )
  }),
).pipe(Layer.provide(ShellEnvironment.layer))
