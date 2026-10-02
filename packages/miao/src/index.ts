import "@miao/core/flag/legacy-env"
import yargs, { type CommandModule } from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@miao/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { Monitor } from "./cli/monitor"

const args = hideBin(process.argv)

// A released single-file binary cannot ship a separate `miao-run` executable, so
// it re-executes itself through this hidden command to run a sandboxed child.
// Intercept here before yargs so the runner stays cheap and does not load the
// command graph.
const sandboxIndex = process.argv.indexOf("__sandbox-run")
if (sandboxIndex !== -1) {
  const { sandboxRun } = await import("./tool/sandbox-runner")
  process.exit(await sandboxRun(process.argv.slice(sandboxIndex + 1)))
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Concrete command modules carry heterogeneous yargs handler argument types, so
// the loader erases to unknown and registration re-asserts the yargs boundary.
type CommandLoader = () => Promise<unknown>

// Command modules load on demand. A process that runs a single command should
// not evaluate the dependency graph of all of them, and `--version` / `--help`
// should evaluate none. The full set loads only for global help or an
// unrecognized command, where yargs needs every command to report correctly.
const commandLoaders: Array<[string, CommandLoader]> = [
  ["acp", () => import("./cli/cmd/acp").then((m) => m.AcpCommand)],
  ["mcp", () => import("./cli/cmd/mcp").then((m) => m.McpCommand)],
  ["attach", () => import("./cli/cmd/attach").then((m) => m.AttachCommand)],
  ["run", () => import("./cli/cmd/run").then((m) => m.RunCommand)],
  ["generate", () => import("./cli/cmd/generate").then((m) => m.GenerateCommand)],
  ["debug", () => import("./cli/cmd/debug").then((m) => m.DebugCommand)],
  ["console", () => import("./cli/cmd/account").then((m) => m.ConsoleCommand)],
  ["providers", () => import("./cli/cmd/providers").then((m) => m.ProvidersCommand)],
  ["agent", () => import("./cli/cmd/agent").then((m) => m.AgentCommand)],
  ["upgrade", () => import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand)],
  ["uninstall", () => import("./cli/cmd/uninstall").then((m) => m.UninstallCommand)],
  ["serve", () => import("./cli/cmd/serve").then((m) => m.ServeCommand)],
  ["remote", () => import("./cli/cmd/remote").then((m) => m.RemoteCommand)],
  ["web", () => import("./cli/cmd/web").then((m) => m.WebCommand)],
  ["models", () => import("./cli/cmd/models").then((m) => m.ModelsCommand)],
  ["stats", () => import("./cli/cmd/stats").then((m) => m.StatsCommand)],
  ["export", () => import("./cli/cmd/export").then((m) => m.ExportCommand)],
  ["import", () => import("./cli/cmd/import").then((m) => m.ImportCommand)],
  ["pr", () => import("./cli/cmd/pr").then((m) => m.PrCommand)],
  ["session", () => import("./cli/cmd/session").then((m) => m.SessionCommand)],
  ["plugin", () => import("./cli/cmd/plug").then((m) => m.PluginCommand)],
  ["db", () => import("./cli/cmd/db").then((m) => m.DbCommand)],
  ["doctor", () => import("./cli/cmd/doctor").then((m) => m.DoctorCommand)],
]
const defaultCommand: CommandLoader = () => import("./cli/cmd/tui").then((m) => m.TuiThreadCommand)

async function buildCli(selection: "all" | "default" | readonly string[]) {
  const cli = yargs(args)
    .parserConfiguration({ "populate--": true })
    .scriptName("miao")
    .wrap(100)
    .help("help", "show help")
    .alias("help", "h")
    .version("version", "show version number", InstallationVersion)
    .alias("version", "v")
    .option("print-logs", {
      describe: "print logs to stderr",
      type: "boolean",
    })
    .option("log-level", {
      describe: "log level",
      type: "string",
      choices: ["DEBUG", "INFO", "WARN", "ERROR"],
    })
    .option("pure", {
      describe: "run without external plugins",
      type: "boolean",
    })
    .middleware(async (opts) => {
      if (opts.printLogs) process.env.MIAO_PRINT_LOGS = "1"
      if (opts.logLevel) process.env.MIAO_LOG_LEVEL = opts.logLevel
      if (opts.pure) {
        process.env.MIAO_PURE = "1"
      }

      Heap.start()
      Monitor.start()

      process.env.AGENT = "1"
      process.env.MIAO = "1"
      process.env.MIAO_PID = String(process.pid)

      // `db` keeps backfill and compact explicit; the rest never touch sessions.
      if (!["db", "upgrade", "uninstall", "completion"].includes(String(opts._[0]))) {
        const { migrateLegacySessions } = await import("./cli/legacy-migration")
        await migrateLegacySessions()
      }
    })
    .usage("")
    .completion("completion", "generate shell completion script")

  const register = async (loader: CommandLoader) => cli.command((await loader()) as CommandModule<any, any>)

  if (selection === "all") {
    for (const [, load] of commandLoaders) await register(load)
    await register(defaultCommand)
  } else if (selection === "default") {
    await register(defaultCommand)
  } else {
    for (const name of selection) {
      const entry = commandLoaders.find(([candidate]) => candidate === name)
      if (entry) await register(entry[1])
    }
  }

  return cli
    .fail((msg, err) => {
      if (
        msg?.startsWith("Unknown argument") ||
        msg?.startsWith("Not enough non-option arguments") ||
        msg?.startsWith("Invalid values:")
      ) {
        if (err) throw err
        cli.showHelp(show)
      }
      if (err) throw err
      process.exit(1)
    })
    .strict()
}

const positional = args.find((arg) => !arg.startsWith("-"))
const wantsHelp = args.includes("-h") || args.includes("--help")
const wantsVersion = args.includes("-v") || args.includes("--version")
const known = positional !== undefined && commandLoaders.some(([name]) => name === positional)
const selection: "all" | "default" | readonly string[] =
  positional !== undefined ? (known ? [positional] : "all") : wantsVersion ? [] : wantsHelp ? "all" : "default"

try {
  if (process.platform === "win32") {
    const { win32EnableVirtualTerminal } = await import("@miao/tui/terminal-win32")
    win32EnableVirtualTerminal()
  }
  const cli = await buildCli(selection)
  if (wantsHelp) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
