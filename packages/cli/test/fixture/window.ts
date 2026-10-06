import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { LocalRuntime } from "../../src/services/local-runtime"
import { layer } from "../../src/services/window-signals"

Effect.gen(function* () {
  const runtime = yield* LocalRuntime.Service
  console.log(JSON.stringify(yield* runtime.transport()))
  yield* Effect.never
}).pipe(
  Effect.provide(Layer.mergeAll(LocalRuntime.layer, layer)),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
)
