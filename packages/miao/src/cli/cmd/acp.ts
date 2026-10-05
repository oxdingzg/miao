import { cmd } from "./cmd"
import { withNetworkOptions, hasArg, resolveNetworkOptionsNoConfig } from "../network"

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("attach", { describe: "connect to an existing server URL", type: "string" })
      .option("cwd", { describe: "working directory", type: "string", default: process.cwd() }),
  async handler(args) {
    const { ServerAuth } = await import("@/server/auth")
    const { OpenCode } = await import("@miao/client")
    const { serve } = await import("@miao/acp")
    const { InstallationVersion } = await import("@miao/core/installation/version")
    process.env.MIAO_CLIENT = "acp"
    const explicit = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].some(hasArg)
    const state: { server?: Awaited<ReturnType<(typeof import("@/server/server"))["Server"]["listen"]>> } = {}
    const client = await (async () => {
      if (args.attach) return OpenCode.make({ baseUrl: args.attach, headers: ServerAuth.headers() })
      if (explicit) {
        const { Server } = await import("@/server/server")
        state.server = await Server.listen(resolveNetworkOptionsNoConfig(args))
        return OpenCode.make({ baseUrl: state.server.url.href, headers: ServerAuth.headers() })
      }
      const { DatabaseFile } = await import("@miao/core/database/file")
      const { RuntimeConnect } = await import("@/runtime/connect")
      const record = await RuntimeConnect.ensure(DatabaseFile.path())
      const notice = RuntimeConnect.mismatch(record)
      if (notice) process.stderr.write(`${notice}\n`)
      return OpenCode.make({
        baseUrl: record.url,
        headers: ServerAuth.headers({ username: "miao", password: record.credential }),
      })
    })()
    const output = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) =>
          process.stdout.write(chunk, (error) => (error ? reject(error) : resolve())),
        ),
    })
    const callbacks: { data?: (chunk: Buffer) => void; end?: () => void; error?: (error: Error) => void } = {}
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        callbacks.data = (chunk) => controller.enqueue(new Uint8Array(chunk))
        callbacks.end = () => controller.close()
        callbacks.error = (error) => controller.error(error)
        process.stdin.on("data", callbacks.data)
        process.stdin.on("end", callbacks.end)
        process.stdin.on("error", callbacks.error)
      },
    })
    try {
      await serve({ client, version: InstallationVersion, output, input }).closed
    } finally {
      if (callbacks.data) process.stdin.off("data", callbacks.data)
      if (callbacks.end) process.stdin.off("end", callbacks.end)
      if (callbacks.error) process.stdin.off("error", callbacks.error)
      await state.server?.stop(true)
    }
  },
})
