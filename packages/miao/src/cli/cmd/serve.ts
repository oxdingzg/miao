import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { applyEngineOptIn } from "@/engine/native-engine"
import { Global } from "@miao/core/global"
import { Flag } from "@miao/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("engine", {
      choices: ["native", "ts"] as const,
      describe:
        "engine placement for sessions served here: native opts new sessions into the rust engine (default storage under the data directory); ts forces the TypeScript engine",
    }),
  describe: "starts a headless miao server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  handler: Effect.fn("Cli.serve")(function* (args) {
    applyEngineOptIn(args.engine, Global.Path.data)
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.MIAO_SERVER_PASSWORD) {
      console.log("Warning: MIAO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const { WindowLifecycle } = yield* Effect.promise(() => import("../../runtime/lifecycle"))
    WindowLifecycle.register(() => server.stop(true))
    console.log(`miao server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
