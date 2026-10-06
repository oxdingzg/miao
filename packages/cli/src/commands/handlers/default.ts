import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Effect } from "effect"
import { LocalRuntime } from "../../services/local-runtime"

export default Runtime.handler(Commands, () =>
  Effect.gen(function* () {
    const runtime = yield* LocalRuntime.Service
    const transport = yield* runtime.transport()
    const { runTui } = yield* Effect.promise(() => import("../../tui"))
    yield* runTui(transport)
  }),
)
