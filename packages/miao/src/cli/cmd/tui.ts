import { WindowLifecycle } from "@/runtime/lifecycle"
import { cmd } from "@/cli/cmd/cmd"
import path from "path"
import os from "os"
import { existsSync } from "fs"
import { UI } from "@/cli/ui"
import { errorMessage } from "@miao/tui/util/error"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { validateSession } from "../tui/validate-session"
import { validateModel } from "../tui/validate-model"

/// Which TUI implementation `miao` starts. The Rust TUI is the default; the
/// TypeScript one stays available through `--tui legacy` or `MIAO_TUI=legacy`.
const DEFAULT_TUI: "rust" | "legacy" = "rust"

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export function selectedTui(args: { tui?: string }, environment = process.env): "rust" | "legacy" {
  const choice = args.tui ?? environment.MIAO_TUI
  return choice === "rust" || choice === "legacy" ? choice : DEFAULT_TUI
}

/// `MIAO_TUI_BIN` first, then the locations `install` writes, then PATH.
export function rustTuiBinary(environment = process.env): string | undefined {
  if (environment.MIAO_TUI_BIN) return environment.MIAO_TUI_BIN
  const name = process.platform === "win32" ? "miao-tui.exe" : "miao-tui"
  const installed = [
    path.join(os.homedir(), ".miao", "bin", name),
    path.join(os.homedir(), ".local", "bin", name),
  ].find((candidate) => existsSync(candidate))
  return installed ?? Bun.which(name) ?? undefined
}

/// Options the Rust TUI does not implement. They are refused rather than
/// silently dropped: a user who asked for `--fork` must not get a different
/// Session than they asked for.
export function unsupportedByRustTui(args: {
  mini?: boolean
  fork?: boolean
  agent?: string
  auto?: boolean
  yolo?: boolean
  "dangerously-skip-permissions"?: boolean
  replay?: boolean
  noReplay?: boolean
  replayLimit?: number
  demo?: boolean
}): string | undefined {
  const options: Array<[string, boolean | undefined]> = [
    ["--mini", args.mini],
    ["--fork", args.fork],
    ["--agent", args.agent !== undefined],
    ["--auto", args.auto || args.yolo || args["dangerously-skip-permissions"]],
    ["--replay", args.replay !== undefined],
    ["--no-replay", args.noReplay],
    ["--replay-limit", args.replayLimit !== undefined],
    ["--demo", args.demo !== undefined],
  ]
  return options.find(([, set]) => set)?.[0]
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start miao tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start miao in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("tui", {
        type: "string",
        choices: ["rust", "legacy"] as const,
        describe: "TUI implementation to start (MIAO_TUI also selects one)",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      if (process.platform === "win32" && !(await import("@miao/tui/terminal-win32")).vtSupported()) {
        UI.error(
          "The interactive interface needs a VT-capable terminal. Use Windows Terminal or PowerShell 7, or run `miao run` for plain output.",
        )
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    if (selectedTui(args) === "rust") {
      const binary = rustTuiBinary()
      // An explicit request owns its failure: silently starting a different
      // TUI would hide that the install is incomplete. The default falls back
      // so an installation that predates the Rust binary keeps working.
      if (!binary && (args.tui === "rust" || process.env.MIAO_TUI === "rust")) {
        UI.error("The Rust TUI is not installed. Reinstall miao, or start the TypeScript TUI with --tui legacy.")
        process.exitCode = 1
        return
      }
      if (binary) {
        const unsupported = unsupportedByRustTui(args)
        if (unsupported) {
          UI.error(`${unsupported} is not supported by the Rust TUI; use --tui legacy`)
          process.exitCode = 1
          return
        }
        if (process.platform === "win32" && !(await import("@miao/tui/terminal-win32")).vtSupported()) {
          UI.error(
            "The interactive interface needs a VT-capable terminal. Use Windows Terminal or PowerShell 7, or run `miao run` for plain output.",
          )
          process.exitCode = 1
          return
        }

        const next = resolveThreadDirectory(args.project)
        try {
          process.chdir(next)
        } catch {
          UI.error("Failed to change directory to " + next)
          process.exitCode = 1
          return
        }
        const cwd = Filesystem.resolve(process.cwd())
        const { DatabaseFile } = await import("@miao/core/database/file")
        const { Global } = await import("@miao/core/global")
        const prompt = await input(args.prompt)
        // The Rust TUI spawns the engine itself, so it needs the same database,
        // configuration directory, and tool bin the TypeScript host would use.
        const argv = [binary, "--workspace", cwd, "--db", DatabaseFile.path(), "--config-dir", Global.Path.config]
        if (args.model) argv.push("--model", args.model)
        if (args.session) argv.push("--session", args.session)
        else if (args.continue) argv.push("--continue")
        if (prompt) argv.push("--prompt", prompt)
        setTimeout(() => {
          void (async () => {
            const { upgrade } = await import("@/cli/upgrade")
            await upgrade()
          })().catch(() => {})
        }, 1000).unref?.()
        const child = Bun.spawn(argv, {
          cwd,
          stdio: ["inherit", "inherit", "inherit"],
          env: { ...process.env, MIAO_TOOL_BIN: Global.Path.bin },
        })
        process.exitCode = await child.exited
        return
      }
      UI.warn("The Rust TUI is not installed; starting the TypeScript TUI. Reinstall miao to get it.")
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    // Argument validation above is terminal-independent, so a non-VT console
    // still reports a usage error before the VT-capability refusal.
    if (process.platform === "win32" && !(await import("@miao/tui/terminal-win32")).vtSupported()) {
      UI.error(
        "The interactive interface needs a VT-capable terminal. Use Windows Terminal or PowerShell 7, or run `miao run` for plain output.",
      )
      process.exitCode = 1
      return
    }

    const unguard =
      process.platform === "win32" ? (await import("@miao/tui/terminal-win32")).win32InstallCtrlCGuard() : undefined
    try {
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the UI and execution use the same directory key.
      const next = resolveThreadDirectory(args.project)
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const network = resolveNetworkOptionsNoConfig(args)
      const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true
      const { RuntimeHost } = await import("@/runtime/host")
      const { DatabaseFile } = await import("@miao/core/database/file")
      const { Server } = await import("@/server/server")
      // Every window owns its Runtime (specs/window-runtime.md §1). Joining
      // another window's Runtime couples this window's lifetime to it — when
      // the host exits or is upgraded, every attached window dies with it.
      // Opening the database here is safe under shared usage protection
      // (#256), and a pending schema migration surfaces the explicit
      // close-other-windows message (#280) instead of silently joining an
      // older execution build.
      const owned = external ? undefined : await RuntimeHost.start(DatabaseFile.path())
      const listener = external ? await Server.listen(network) : undefined
      const reload = () => {
        void (async () => {
          // The server resolves location-scoped services directly, so
          // reload only tells
          // the UI bridge to resync. Server-side config reload is a separate
          // V2 gap (roadmap §1.3).
          const { emitGlobalDisposed } = await import("@/server/global-lifecycle")
          emitGlobalDisposed()
        })().catch(console.error)
      }
      process.on("SIGUSR2", reload)
      const stop = async () => {
        process.off("SIGUSR2", reload)
        await owned?.stop()
        await listener?.stop(true)
      }

      const unregister = WindowLifecycle.register(stop)
      try {
        const prompt = await input(args.prompt)
        const { TuiConfig } = await import("@/config/tui")
        const config = await TuiConfig.get()

        const { ServerAuth } = await import("@/server/auth")
        const transport = external
          ? { url: listener!.url.href, headers: ServerAuth.headers() }
          : {
              url: owned!.record.url,
              headers: ServerAuth.headers({ username: "miao", password: owned!.record.credential }),
            }

        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,

            headers: transport.headers,
          })
          await validateModel({
            url: transport.url,
            model: args.model,
            directory: cwd,

            headers: transport.headers,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        setTimeout(() => {
          void (async () => {
            const { upgrade } = await import("@/cli/upgrade")
            await upgrade()
          })().catch(() => {})
        }, 1000).unref?.()

        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: transport.url,
            runtimeTarget: owned ? { runtimeID: owned.record.runtimeID, storage: DatabaseFile.path() } : undefined,
            async onSnapshot() {
              const { writeHeapSnapshot } = await import("node:v8")
              return [writeHeapSnapshot("miao.heapsnapshot")]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,

            headers: transport.headers,

            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
      } finally {
        await stop()
        unregister()
      }
    } finally {
      try {
        unguard?.()
      } catch {}
    }
  },
})
