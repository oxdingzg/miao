import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const { OpenCode } = yield* Effect.promise(() => import("@miao/client"))
    const { serve } = yield* Effect.promise(() => import("@miao/acp"))
    const { InstallationVersion } = yield* Effect.promise(() => import("@miao/core/installation/version"))
    process.env.MIAO_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    // The adapter only speaks the V2 protocol to this process's server, like any other client.
    const client = OpenCode.make({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    const output = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))),
    })
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    serve({ client, version: InstallationVersion, output, input })

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
