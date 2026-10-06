#!/usr/bin/env bun

import { InstallationExecutable } from "@miao/core/installation/executable"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { LocalRuntime } from "./services/local-runtime"
import { layer } from "./services/window-signals"

if (process.argv.includes("--build-id")) {
  console.log(InstallationExecutable.buildID)
  process.exit(0)
}

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  api: () => import("./commands/handlers/api"),
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
  },
  migrate: () => import("./commands/handlers/migrate"),
  serve: () => import("./commands/handlers/serve"),
})

Runtime.run(Commands, Handlers, { version: "local" }).pipe(
  Effect.provide(Layer.mergeAll(LocalRuntime.layer, layer)),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
