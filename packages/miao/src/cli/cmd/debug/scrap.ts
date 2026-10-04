import { EOL } from "os"
import { cmd } from "../cmd"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  async handler() {
    const { ProjectMetadata } = await import("@miao/core/project/metadata")
    const { AppNodeBuilder } = await import("@miao/core/effect/app-node-builder")
    const { makeRuntime } = await import("@miao/core/effect/runtime")
    const runtime = makeRuntime(ProjectMetadata.Service, AppNodeBuilder.build(ProjectMetadata.node))
    const list = await runtime.runPromise((project) => project.list())
    process.stdout.write(JSON.stringify(list, null, 2) + EOL)
  },
})
