import { cmd } from "./cmd"
import { DatabaseFile } from "@miao/core/database/file"

/** Private pane integration; never discovers or starts a server. */
export const RuntimeCommand = cmd({
  command: "runtime <action>",
  builder: (yargs) => yargs.positional("action", { choices: ["access"] as const }),
  describe: false,
  async handler() {
    const { RuntimeAccessCLI } = await import("./runtime-access")
    console.log(JSON.stringify(await RuntimeAccessCLI.run(DatabaseFile.path())))
  },
})
