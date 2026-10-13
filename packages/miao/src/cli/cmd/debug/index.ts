import { Global } from "@miao/core/global"
import { InstallationVersion } from "@miao/core/installation/version"
import { Flag } from "@miao/core/flag/flag"
import { Config } from "@miao/core/config"
import { ConfigPluginV1 } from "@miao/core/v1/config/plugin"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { readUpgradeResult } from "@/installation/upgrade-result"
import { ConfigPlugin } from "@/config/plugin"
import type { CommandModule } from "yargs"
import os from "os"
import { Duration, Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

type Loader = () => Promise<unknown>

// Debug subcommands pull in heavy graphs (LSP, location services, catalog,
// snapshot). Register only the requested one so `miao debug startup` does not
// evaluate all of them; global help still needs the full set.
const subcommands: Array<[string, Loader]> = [
  ["config", () => import("./config").then((m) => m.ConfigCommand)],
  ["lsp", () => import("./lsp").then((m) => m.LSPCommand)],
  ["rg", () => import("./ripgrep").then((m) => m.RipgrepCommand)],
  ["file", () => import("./file").then((m) => m.FileCommand)],
  ["scrap", () => import("./scrap").then((m) => m.ScrapCommand)],
  ["skill", () => import("./skill").then((m) => m.SkillCommand)],
  ["snapshot", () => import("./snapshot").then((m) => m.SnapshotCommand)],
  ["startup", () => import("./startup").then((m) => m.StartupCommand)],
  ["v2", () => import("./v2").then((m) => m.V2Command)],
]

const argv = process.argv.slice(2)
const debugAt = argv.indexOf("debug")
const requested = debugAt >= 0 ? argv.slice(debugAt + 1).find((arg) => !arg.startsWith("-")) : undefined
const globalHelp = argv.includes("-h") || argv.includes("--help")
const selected =
  globalHelp || requested === undefined ? subcommands : subcommands.filter(([name]) => name === requested)
const loaded = await Promise.all(selected.map(async ([, load]) => (await load()) as CommandModule<any, any>))

export const DebugCommand = cmd({
  command: "debug",
  describe: "debugging and troubleshooting tools",
  builder: (yargs) => {
    const withCommands = loaded.reduce((acc, command) => acc.command(command), yargs)
    return withCommands.command(InfoCommand).command(PathsCommand).command(WaitCommand).demandCommand()
  },
  async handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: "wait indefinitely (for debugging)",
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

const InfoCommand = effectCmd({
  command: "info",
  describe: "show debug information",
  handler: () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const merged = Config.merge(yield* config.entries())
      const termProgram = process.env.TERM_PROGRAM
        ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
        : undefined
      const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

      console.log(`miao version: ${InstallationVersion}`)
      console.log(`os: ${os.type()} ${os.release()} ${os.arch()}`)
      console.log(`terminal: ${terminal || "unknown"}`)
      const last = yield* Effect.promise(() => readUpgradeResult())
      console.log(
        `last auto-update: ${
          last ? `${last.outcome} ${last.versionFrom} → ${last.versionTo}${last.error ? ` (${last.error})` : ""}` : "none"
        }`,
      )
      console.log("plugins:")
      if (Flag.MIAO_PURE) {
        console.log("external plugins disabled (--pure)")
        return
      }
      const specs: ConfigPluginV1.Spec[] = [
        ...(Array.isArray(merged.plugins) ? (merged.plugins as ConfigPluginV1.Spec[]) : []),
        ...(yield* Effect.promise(() => ConfigPlugin.load(process.cwd()))),
      ]
      if (!specs.length) {
        console.log("none")
        return
      }
      for (const spec of specs) {
        console.log(`- ${ConfigPlugin.pluginSpecifier(spec)}`)
      }
    }).pipe(
      Effect.withSpan("Cli.debug.info"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})

const PathsCommand = cmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  handler() {
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), value)
    }
  },
})
