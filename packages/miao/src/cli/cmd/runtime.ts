import { cmd } from "./cmd"
import { DatabaseFile } from "@miao/core/database/file"

export const RuntimeCommand = cmd({
  command: "runtime [action]",
  describe: "run the persistent local session Runtime",
  builder: (yargs) =>
    yargs.positional("action", { choices: ["start", "status", "stop", "access"] as const, default: "start" }),
  async handler(args) {
    if (args.action === "access") {
      const { RuntimeAccessCLI } = await import("./runtime-access")
      console.log(JSON.stringify(await RuntimeAccessCLI.run(DatabaseFile.path())))
      return
    }
    if (args.action !== "start") {
      const { RuntimeConnect } = await import("@/runtime/connect")
      const record = await RuntimeConnect.current(DatabaseFile.path())
      if (!record) {
        console.log("No local Runtime is running")
        return
      }
      if (args.action === "status") {
        console.log(`miao Runtime ${record.version} (protocol ${record.protocol}) ready at ${record.url}`)
        return
      }
      await RuntimeConnect.stop(DatabaseFile.path(), record)
      console.log("Runtime stopped")
      return
    }
    const { RuntimeHost } = await import("@/runtime/host")
    const runtime = await RuntimeHost.start(DatabaseFile.path())
    console.log(`miao Runtime ready at ${runtime.record.url}`)
    try {
      await Promise.race([
        runtime.closed,
        new Promise<void>((resolve) => {
          process.once("SIGINT", resolve)
          process.once("SIGTERM", resolve)
        }),
      ])
    } finally {
      await runtime.stop()
    }
  },
})
