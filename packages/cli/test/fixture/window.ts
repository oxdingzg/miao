import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { LocalRuntime } from "../../src/services/local-runtime"

Effect.gen(function* () {
  const runtime = yield* LocalRuntime.Service
  console.log(JSON.stringify(yield* runtime.transport()))
  yield* Effect.never
}).pipe(Effect.provide(LocalRuntime.layer), Effect.provide(NodeServices.layer), Effect.scoped, NodeRuntime.runMain)
