import { FSUtil } from "@miao/core/fs-util"
// CLI entry point for `miao run` and `miao --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`miao --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`miao --mini --attach`): connects to a running
//      miao server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import type { ToolPart } from "@miao/schema/view-models"
import { createClient, type Client } from "@/client"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"

type ModelInput = { providerID: string; modelID: string }

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run miao with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running miao server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to MIAO_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to MIAO_SERVER_USERNAME or 'miao')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
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
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const interactive = args.mini
      // Headless runs and the interactive --mini mode both speak V2.
      const headlessV2 = !interactive
      const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !interactive) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      // Session routes use V2; the V1 routes write the retired V1 tables, which
      // fail once a database has been compacted.
      async function sessionV2(sdk: Client): Promise<SessionInfo | undefined> {
        const where = directory ?? root
        const pick = async (id: string) => {
          if (!args.fork) {
            const found = await sdk.sessions.get({ sessionID: id }).then((result) => result)
            return found && { id: found.id, title: found.title, directory: found.location.directory }
          }
          const forked = await sdk.sessions.fork({ sessionID: id }).then((result) => result)
          return forked && { id: forked.id, title: forked.title, directory: forked.location.directory }
        }
        if (args.session) {
          const found = await sdk.sessions
            .get({ sessionID: args.session })
            .then((result) => result)
            .catch(() => undefined)
          if (!found) {
            UI.error("Session not found")
            process.exit(1)
          }
          return pick(found.id)
        }
        const base = args.continue
          ? await sdk.sessions
              .list({ order: "desc", limit: 50, directory: where })
              .then((result) => result.data.find((item) => !item.parentID))
          : undefined
        if (base) return pick(base.id)
        const created = await sdk.sessions.create({ location: { directory: where } }).then((result) => result)
        if (!created) return
        const name = title()
        if (name) await sdk.sessions.rename({ sessionID: created.id, title: name })
        return { id: created.id, title: name ?? created.title, directory: created.location.directory }
      }

      // Sharing was removed; the interactive runtime still takes this hook.
      async function share(_sdk: Client, _sessionID: string) {}

      // The selected agent and model are switched on the new session, which is
      // what a V2 prompt then runs with.
      async function createFreshSessionV2(
        sdk: Client,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const created = await sdk.sessions
          .create({ location: { directory: directory ?? root } }, {})
          .then((result) => result)
        if (input.agent) await sdk.sessions.switchAgent({ sessionID: created.id, agent: input.agent })
        if (input.model)
          await sdk.sessions.switchModel({
            sessionID: created.id,
            model: { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant },
          })
        const name = args.title !== undefined && args.title !== "" ? args.title : undefined
        if (name) await sdk.sessions.rename({ sessionID: created.id, title: name })
        void share(sdk, created.id).catch(() => {})
        return { id: created.id, title: name ?? created.title }
      }

      async function current(sdk: Client): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.location
          .path()
          .then((x) => x.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: Client) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.agents
          .list(undefined, {})
          .then((x) => x.data)
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.id === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: Client) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: Client) {
        const sess = await sessionV2(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        if (headlessV2) {
          const { runHeadless } = await import("./run/headless")
          const error = await runHeadless({
            client,
            sessionID,
            directory: cwd,
            agent,
            model: pick(args.model),
            variant: args.variant,
            message,
            files,
            command: args.command,
            thinking,
            json: args.format === "json",
            auto: Boolean(auto),
            emit,
            print: {
              header(agentName, modelID) {
                UI.empty()
                UI.println(`> ${agentName} · ${modelID}`)
                UI.empty()
              },
              tool,
              toolError,
              text(text) {
                if (!process.stdout.isTTY) return void process.stdout.write(text + EOL)
                UI.empty()
                UI.println(text)
                UI.empty()
              },
              reasoning(text) {
                const line = `Thinking: ${text}`
                if (!process.stdout.isTTY) return void process.stdout.write(line + EOL)
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
              },
              warning(text) {
                UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + text)
              },
              error(text) {
                UI.error(text)
              },
            },
          })
          if (error) process.exitCode = 1
          return
        }

        const model = pick(args.model)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSessionV2,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (interactive && !args.attach && !args.session && !args.continue) {
        const model = pick(args.model)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: localAgent,
            session: sessionV2,
            share,
            createSession: createFreshSessionV2,
            agent: args.agent,
            model,
            variant: args.variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createClient({
        baseUrl: "http://opencode.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "miao",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    model: input.model,
    agent: input.agent,
    format: "default",
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    interactive: false,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    demo: input.demo ?? false,
  })
}
