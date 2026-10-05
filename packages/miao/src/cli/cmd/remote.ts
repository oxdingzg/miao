import type { Argv } from "yargs"
import { appendFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
import { InstallationVersion } from "@miao/core/installation/version"
import type { AccountStatus, ConnectorStatus, FlowStep, Host, LoginFlow, LoginInput } from "@miao/remote"
import type { RemoteControl } from "@miao/server/remote-control"
import { fail } from "../effect-cmd"
import { cmd } from "./cmd"

const DefaultPort = 4097

// Credentials sit next to auth.json and mcp-auth.json but in their own file, so a
// bot token is never read as a provider key. Cursors, router state, and locks
// live under the state directory, one directory per connector account.
const paths = () => ({
  auth: path.join(Global.Path.data, "remote-auth.json"),
  state: path.join(Global.Path.state, "remote"),
  log: path.join(Global.Path.log, "remote.log"),
  agents: path.join(Global.Path.home, "Library", "LaunchAgents"),
})

const loadRemoteConfig = Effect.fn("Cli.remote.config")(function* () {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return { remote: config.remote ?? {}, model: config.model }
})

/** The parts of `remote` a local host reads; the server config and the SDK's config both satisfy it. */
type RemoteSettings = {
  readonly connectors?: ReadonlyArray<string>
  readonly wechat?: object
  readonly qq?: object
  readonly settings?: { readonly [id: string]: Readonly<Record<string, unknown>> }
}

/** Built-in connectors plus `remote.connectors`; npm packages install like plugins. */
async function connectorsFor(remote: RemoteSettings, log: (message: string) => void) {
  const { loadConnectors } = await import("@miao/remote/load")
  const { builtinConnectors } = await import("@miao/remote/builtin")
  const { Npm } = await import("@miao/core/npm")
  const result = await loadConnectors({
    builtins: builtinConnectors,
    specs: remote.connectors ?? [],
    cwd: Global.Path.home,
    install: async (spec) => {
      const entry = await Npm.add(spec)
      return entry.entrypoint ? pathToFileURL(entry.entrypoint).href : entry.directory
    },
  })
  result.errors.forEach((error) => log(`无法加载连接器 ${error.spec}：${error.error}`))
  return result.connectors
}

function connectorOptions(remote: RemoteSettings) {
  return (id: string): Readonly<Record<string, unknown>> => {
    if (id === "wechat") return { ...remote.wechat }
    if (id === "qq") return { ...remote.qq }
    return remote.settings?.[id] ?? {}
  }
}

async function createLocalHost(remote: RemoteSettings, log: (message: string) => void) {
  const { createHost, migrate } = await import("@miao/remote")
  const files = paths()
  await migrate({ authFile: files.auth, stateDir: files.state })
  return createHost({
    authFile: files.auth,
    stateDir: files.state,
    connectors: await connectorsFor(remote, log),
    options: connectorOptions(remote),
    agentVersion: InstallationVersion,
    log,
  })
}

const RunCommand = cmd({
  command: "$0",
  describe: "run the persistent Runtime with its IM channels (foreground)",
  async handler() {
    const { RuntimeCommand } = await import("./runtime")
    await RuntimeCommand.handler({ $0: "miao", _: ["runtime"], action: "start" })
  },
})

const LoginCommand = cmd({
  command: "login <connector>",
  describe: "connect an IM account through the local Runtime",
  builder: (yargs: Argv) =>
    yargs.positional("connector", {
      type: "string",
      demandOption: true,
      describe: "connector id: wechat, qq, or a configured connector",
    }),
  async handler(args) {
    const { RuntimeConnect } = await import("@/runtime/connect")
    const { DatabaseFile } = await import("@miao/core/database/file")
    const { OpenCode } = await import("@miao/client")
    const { ServerAuth } = await import("@/server/auth")
    const record = await RuntimeConnect.ensure(DatabaseFile.path())
    const remote = OpenCode.make({
      baseUrl: record.url,
      headers: ServerAuth.headers({ username: "miao", password: record.credential }),
    }).remote
    const status = await remote.get()
    const connector = status.connectors.find((item) => item.id === args.connector)
    if (!connector) throw new Error(`没有名为 ${args.connector} 的连接器`)
    console.log(`通过本机 Runtime（pid ${status.pid}）登录`)
    if (connector.notice) console.log(connector.notice)
    const started = await remote.login({ connector: connector.id })
    const result = await renderLogin(remote.loginEvents({ flow: started.flow }), async (value) => {
      await remote.loginInput({ flow: started.flow, value })
      return true
    })
    if (result?.type !== "done") throw new Error(result?.type === "error" ? result.message : "登录没有完成")
    console.log(`已连接${connector.name}（${result.account.id}），立即接入当前 Runtime`)
  },
})

/** The daemon's control routes, backed by its connector host. */
function control(host: Host, port: number | (() => number)): RemoteControl.Interface {
  const startedAt = Date.now()
  return {
    status: async () => ({
      pid: process.pid,
      port: typeof port === "function" ? port() : port,
      version: InstallationVersion,
      startedAt,
      connectors: await host.status(),
    }),
    login: async (connector) => (host.connector(connector) ? { flow: host.login(connector).id } : undefined),
    events: (flow) => host.flow(flow)?.events(),
    input: (id, value) => {
      const flow = host.flow(id)
      if (!flow) return "unknown"
      return flow.input(value) ? "accepted" : "idle"
    },
    cancel: (id) => {
      const flow = host.flow(id)
      flow?.cancel()
      return flow !== undefined
    },
    remove: (connector, account) => host.remove(connector, account),
    pair: async (connector, account) => {
      const result = await host.pair(connector, account)
      if (result.ok) return result.step
      return result.unknown ? undefined : { error: result.message }
    },
    test: (connector, account) => host.test(connector, account),
  }
}

/** IM channels live inside the persistent Runtime and use its authenticated API. */
export async function prepareRuntimeIM(credential: string) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const config = await AppRuntime.runPromise(loadRemoteConfig())
  const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
  const host = await createLocalHost(config.remote, log)
  const state: { port: number; router?: Awaited<ReturnType<(typeof import("@miao/remote"))["createRouter"]>> } = {
    port: 0,
  }
  return {
    port: config.remote.port ?? 0,
    control: control(host, () => state.port),
    async start(url: URL) {
      state.port = Number(url.port)
      const opened = await host.open()
      opened.failures.forEach((failure) => log(`${failure.id}: ${failure.error}`))
      const accounts = (await host.status()).flatMap((connector) => connector.accounts)
      if (!accounts.length) log("还没有登录任何 IM，可在 /remote 中连接账号")
      if (accounts.some((account) => account.state === "needs-login")) log("已有 IM 登录失效，请重新扫码登录")
      const { OpenCode } = await import("@miao/client")
      const { ServerAuth } = await import("@/server/auth")
      const { createRouter } = await import("@miao/remote")
      state.router = await createRouter({
        client: OpenCode.make({
          baseUrl: url.href,
          headers: ServerAuth.headers({ username: "miao", password: credential }),
        }),
        channels: opened.channels,
        projects: config.remote.projects ?? {},
        allow: host.allow,
        state: path.join(paths().state, "router.json"),
        model: parseModel(config.model),
        attach: `miao attach ${url.href}`,
        log,
      })
      host.bind({ add: state.router.add, remove: state.router.remove })
      await state.router.start()
    },
    async stop() {
      host.bind(undefined)
      await host.close()
      await state.router?.stop()
    },
  }
}

/** Prints login steps in a terminal and answers code and form steps from stdin. Returns the last step. */
export async function renderLogin(steps: AsyncIterable<FlowStep>, answer: (value: LoginInput) => Promise<boolean>) {
  const { renderUnicodeCompact } = await import("uqr")
  const { createInterface } = await import("node:readline/promises")
  const ask = async (prompt: string) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout })
    const value = await reader.question(prompt)
    reader.close()
    return value
  }
  const seen: FlowStep[] = []
  for await (const step of steps) {
    seen.push(step)
    if (step.type === "qr") {
      if (step.hint) console.log(step.hint)
      console.log(renderUnicodeCompact(step.content, { border: 1 }))
      console.log(`二维码显示不全时，用手机打开这个链接：${step.content}`)
    }
    if (step.type === "progress") console.log(step.message)
    if (step.type === "open") console.log(`${step.hint ?? "在浏览器里打开"}：${step.url}`)
    if (step.type === "code") await answer((await ask(step.prompt)).trim())
    if (step.type === "form") {
      console.log(step.title)
      const values: Record<string, string> = {}
      for (const field of step.fields)
        values[field.key] = (await ask(`${field.label}${field.optional ? "（可留空）" : ""}：`)).trim()
      await answer(values)
    }
    if (step.type === "pair") {
      console.log(`配对码：${step.code}`)
      console.log(step.hint)
      if (step.link) {
        console.log(renderUnicodeCompact(step.link, { border: 1 }))
        console.log(`或打开：${step.link}`)
      }
    }
  }
  return seen.at(-1)
}

const StatusCommand = cmd({
  command: "status",
  describe: "show the running Runtime's IM accounts and usage",
  async handler() {
    const { RuntimeConnect } = await import("@/runtime/connect")
    const { DatabaseFile } = await import("@miao/core/database/file")
    const record = await RuntimeConnect.current(DatabaseFile.path())
    if (process.platform === "darwin") {
      const { Label } = await import("@miao/remote/launchd")
      if (await Bun.file(path.join(paths().agents, `${Label}.plist`)).exists()) console.log("launchd：已安装")
    }
    if (!record) {
      console.log("Runtime 未运行；运行 miao 会自动启动")
      return
    }
    const { OpenCode } = await import("@miao/client")
    const { ServerAuth } = await import("@/server/auth")
    const status = await OpenCode.make({
      baseUrl: record.url,
      headers: ServerAuth.headers({ username: "miao", password: record.credential }),
    }).remote.get()
    console.log([`Runtime：${record.url}（pid ${status.pid}）`, ...statusLines(status.connectors)].join("\n"))
  },
})

export function statusLines(status: ReadonlyArray<ConnectorStatus>) {
  return status.flatMap((connector) => {
    if (connector.accounts.length === 0) return [`${connector.name}：未登录（miao remote login ${connector.id}）`]
    return connector.accounts.flatMap((account) => accountLines(connector, account))
  })
}

function accountLines(connector: ConnectorStatus, account: AccountStatus) {
  const verb = connector.transport === "poll" ? "轮询" : "连接"
  return [
    `${connector.name}：${account.account}` +
      (account.owner ? `，主人 ${account.owner}` : "，还没有配对主人") +
      (account.state === "needs-login"
        ? `，登录已失效（${account.error ?? "需要重新登录"}），请重新登录（miao remote login ${connector.id}）`
        : ""),
    `${verb}：${account.pid ? `运行中（pid ${account.pid}）` : "未运行"}` +
      (account.detail ? `，最近状态 ${account.detail}` : "") +
      (account.lastActivityAt ? `，最近活动 ${new Date(account.lastActivityAt).toLocaleString()}` : "") +
      (account.error && account.state !== "needs-login" ? `，最近错误 ${account.error}` : ""),
    `  今日主动推送 ${account.pushesToday}${account.pushBudget === undefined ? "" : `/${account.pushBudget}`}，` +
      `待取结果 ${account.pending} 条，待审批 ${account.approvals} 个`,
  ]
}

const InstallCommand = cmd({
  command: "install",
  describe: "write a launchd agent that keeps miao remote running (does not load it)",
  handler: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (process.platform !== "darwin") return yield* fail("目前只支持 macOS（launchd）")
        const { Label, plist } = yield* Effect.promise(() => import("@miao/remote/launchd"))
        const files = paths()
        const file = path.join(files.agents, `${Label}.plist`)
        yield* Effect.promise(() => mkdir(files.agents, { recursive: true }))
        yield* Effect.promise(() => mkdir(path.dirname(files.log), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            file,
            plist({
              program: remoteProgram(),
              workingDirectory: Global.Path.home,
              logFile: files.log,
              environment: agentEnvironment(),
            }),
          ),
        )
        const uid = process.getuid?.() ?? 0
        console.log(
          [
            `已写入 ${file}`,
            `日志：${files.log}`,
            "",
            "加载并启动（需要你自己执行）：",
            `  launchctl bootstrap gui/${uid} ${file}`,
            "重启：",
            `  launchctl kickstart -k gui/${uid}/${Label}`,
            "",
            "注意：plist 不包含 MIAO_SERVER_PASSWORD。需要服务密码时，请自行在 plist 的 EnvironmentVariables 里添加，",
            "并保证文件权限只有你自己可读。",
          ].join("\n"),
        )
      }),
    ),
})

const UninstallCommand = cmd({
  command: "uninstall",
  describe: "remove the launchd agent file (prints the command to unload it)",
  handler: () =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (process.platform !== "darwin") return yield* fail("目前只支持 macOS（launchd）")
        const { Label } = yield* Effect.promise(() => import("@miao/remote/launchd"))
        const file = path.join(paths().agents, `${Label}.plist`)
        const existed = yield* Effect.promise(() => Bun.file(file).exists())
        yield* Effect.promise(() => rm(file, { force: true }))
        const uid = process.getuid?.() ?? 0
        console.log(
          [
            existed ? `已删除 ${file}` : `${file} 不存在`,
            "如果它已经加载，请执行以下命令停止（需要你自己执行）：",
            `  launchctl bootout gui/${uid}/${Label}`,
          ].join("\n"),
        )
      }),
    ),
})

/** The command that runs the daemon: a source checkout runs through bun; a compiled binary is its own executable. */
function remoteProgram() {
  return Bun.main.endsWith(".ts") ? [process.execPath, "run", Bun.main, "remote"] : [process.execPath, "remote"]
}

/** The launchd agent's environment. It never includes MIAO_SERVER_PASSWORD. */
function agentEnvironment() {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", HOME: Global.Path.home }
}

/**
 * What the TUI's /remote does on this machine when no daemon answers: it logs in
 * through the same connector host as `miao remote login` (same credentials file,
 * so a daemon started later picks the account up), and starts or stops the daemon
 * once the user confirms. Messages go to remote.log because the TUI owns the terminal.
 */
export async function createRemoteLocal(remote: RemoteSettings | undefined) {
  const { createDaemonControl, system } = await import("@miao/remote/daemon")
  const settings = remote ?? {}
  const files = paths()
  const log = (message: string) =>
    void mkdir(path.dirname(files.log), { recursive: true })
      .then(() => appendFile(files.log, `${new Date().toISOString()} tui: ${message}\n`))
      .catch(() => undefined)
  // Status and removal share one host that never opens channels; each login gets its own, closed when it ends.
  const shared = { host: undefined as Promise<Host> | undefined }
  const host = () => (shared.host ??= createLocalHost(settings, log))
  const flows = new Map<string, LoginFlow>()
  const flow = (id: string) => {
    const found = flows.get(id)
    if (!found) throw new Error("登录已结束")
    return found
  }
  return {
    setup: async (input: Parameters<typeof import("@miao/remote-control/hub-setup").connect>[0]) => {
      const { HubSetup } = await import("@miao/remote-control/hub-setup")
      return HubSetup.connect(input)
    },
    status: () => host().then((item) => item.status()),
    login: async (connector: string) => {
      const local = await createLocalHost(settings, log)
      if (!local.connector(connector)) {
        await local.close()
        throw new Error(`没有名为 ${connector} 的连接器`)
      }
      const started = local.login(connector)
      flows.set(started.id, started)
      void drain(started).then(() => {
        flows.delete(started.id)
        return local.close()
      })
      return started.id
    },
    events: (id: string, signal: AbortSignal) => flow(id).events(signal),
    input: async (id: string, value: LoginInput) => {
      if (!flow(id).input(value)) throw new Error("现在没有等待输入的步骤")
    },
    cancel: async (id: string) => flows.get(id)?.cancel(),
    remove: async (connector: string, account: string) => {
      const item = await host()
      await item.remove(connector, account)
    },
    daemon: createDaemonControl({
      program: remoteProgram(),
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
      home: Global.Path.home,
      agents: files.agents,
      log: files.log,
      environment: agentEnvironment(),
      system,
    }),
  }
}

/** Resolves once a login flow has finished. */
async function drain(flow: LoginFlow) {
  for await (const _ of flow.events()) continue
}

export const RemoteCommand = cmd({
  command: "remote",
  describe: "drive sessions from WeChat, QQ, and other IM apps",
  builder: (yargs: Argv) =>
    yargs
      .command(RunCommand)
      .command(LoginCommand)
      .command(StatusCommand)
      .command(InstallCommand)
      .command(UninstallCommand),
  handler: async () => {},
})

function parseModel(model: string | undefined) {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}
