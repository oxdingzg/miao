import type { Argv } from "yargs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
import { InstallationVersion } from "@miao/core/installation/version"
import type { AccountStatus, ConnectorStatus, FlowStep, LoginInput } from "@miao/remote"
import { effectCmd, fail } from "../effect-cmd"

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

type RemoteConfig = Effect.Success<ReturnType<typeof loadRemoteConfig>>["remote"]

/** Built-in connectors plus `remote.connectors`; npm packages install like plugins. */
async function connectorsFor(remote: RemoteConfig, log: (message: string) => void) {
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

function connectorOptions(remote: RemoteConfig) {
  return (id: string): Readonly<Record<string, unknown>> => {
    if (id === "wechat") return { ...remote.wechat }
    if (id === "qq") return { ...remote.qq }
    return remote.settings?.[id] ?? {}
  }
}

async function createLocalHost(remote: RemoteConfig, log: (message: string) => void) {
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

const RunCommand = effectCmd({
  command: "$0",
  describe: "run the miao server with the logged-in IM channels (foreground)",
  instance: false,
  handler: Effect.fn("Cli.remote.run")(function* () {
    const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
    const config = yield* loadRemoteConfig()
    const host = yield* Effect.promise(() => createLocalHost(config.remote, log))
    const status = yield* Effect.promise(() => host.status())
    const accounts = status.flatMap((connector) => connector.accounts.map((account) => ({ connector, account })))
    if (accounts.length === 0)
      return yield* fail("还没有登录任何 IM：先运行 miao remote login wechat（或 miao remote login qq）")
    accounts
      .filter((item) => item.account.state === "needs-login")
      .forEach((item) =>
        console.error(
          `${item.connector.name}（${item.account.account}）登录已失效（${item.account.error ?? "需要重新登录"}），请运行 miao remote login ${item.connector.id} 重新扫码`,
        ),
      )
    const opened = yield* Effect.promise(() => host.open())
    opened.failures.forEach((failure) => console.error(`${failure.id}：${failure.error}`))
    // Exit 0 so the launchd agent (KeepAlive on failure only) does not restart into the same dead login.
    if (opened.channels.length === 0) return
    const projects = config.remote.projects ?? {}
    if (Object.keys(projects).length === 0)
      console.error("提示：配置里没有 remote.projects，IM 里将看不到也建不了任何会话")
    if (!Flag.MIAO_SERVER_PASSWORD)
      console.error("提示：MIAO_SERVER_PASSWORD 没有设置，本机其它进程可以不经鉴权访问 127.0.0.1 上的服务")

    const port = config.remote.port ?? DefaultPort
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const server = yield* Effect.tryPromise({
      try: () => Server.listen({ hostname: "127.0.0.1", port, mdns: false, cors: [] }),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(`无法在 127.0.0.1:${port} 启动服务（端口被占用？）：${String(error)}`)))
    const url = `http://127.0.0.1:${server.port}`
    const attach = `miao attach ${url}`

    const { OpenCode } = yield* Effect.promise(() => import("@miao/client"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const { createRouter } = yield* Effect.promise(() => import("@miao/remote"))
    const router = yield* Effect.promise(() =>
      createRouter({
        client: OpenCode.make({ baseUrl: url, headers: ServerAuth.headers() }),
        channels: opened.channels,
        projects,
        allow: host.allow,
        state: path.join(paths().state, "router.json"),
        model: parseModel(config.model),
        attach,
        log,
      }),
    )
    const started = yield* Effect.promise(() =>
      router.start().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    )
    if (started !== undefined) {
      yield* Effect.promise(() => router.stop().catch(() => undefined))
      yield* Effect.promise(() => server.stop(true))
      return yield* fail(started)
    }
    host.bind({ add: router.add, remove: router.remove })
    console.log(`miao remote 已启动：${opened.channels.map((channel) => channel.id).join("、")}，服务 ${url}`)
    console.log(`桌面查看或操作这些会话：${attach}`)

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve())
          process.once("SIGTERM", () => resolve())
        }),
    )
    host.bind(undefined)
    yield* Effect.promise(() => host.close())
    yield* Effect.promise(() => router.stop())
    yield* Effect.promise(() => server.stop(true))
  }),
})

const LoginCommand = effectCmd({
  command: "login <connector>",
  describe: "connect an IM account (scan a QR code or enter a token)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("connector", {
      type: "string",
      demandOption: true,
      describe: "connector id: wechat, qq, or a third-party connector from remote.connectors",
    }),
  handler: Effect.fn("Cli.remote.login")(function* (args: { connector: string }) {
    const log = (message: string) => console.error(message)
    const config = yield* loadRemoteConfig()
    const host = yield* Effect.promise(() => createLocalHost(config.remote, log))
    const connector = host.connector(args.connector)
    if (!connector)
      return yield* fail(
        `没有名为 ${args.connector} 的连接器；可用：${host
          .connectors()
          .map((item) => item.id)
          .join("、")}`,
      )
    if (connector.notice) console.log(`${connector.notice}\n`)
    const flow = host.login(connector.id)
    const last = yield* Effect.promise(() =>
      renderLogin(flow.events(), async (value) => flow.input(value)).finally(() => host.close()),
    )
    if (last?.type !== "done") return yield* fail(last?.type === "error" ? last.message : "登录没有完成")
    console.log(
      `已连接${connector.name}（${last.account.id}）${last.message ? `，${last.message}` : ""}。凭证保存在 ${paths().auth}（0600）`,
    )
    console.log("运行 miao remote 启动；如果它已经在运行，请重启它以使用新凭证")
  }),
})

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

const StatusCommand = effectCmd({
  command: "status",
  describe: "show connected IM accounts, their state, today's push usage, and held results",
  instance: false,
  handler: Effect.fn("Cli.remote.status")(function* () {
    const { Label } = yield* Effect.promise(() => import("@miao/remote/launchd"))
    const files = paths()
    const config = yield* loadRemoteConfig()
    const host = yield* Effect.promise(() => createLocalHost(config.remote, (message) => console.error(message)))
    const status = yield* Effect.promise(() => host.status())
    const installed = yield* Effect.promise(() => Bun.file(path.join(files.agents, `${Label}.plist`)).exists())
    console.log(
      [
        `服务端口：127.0.0.1:${config.remote.port ?? DefaultPort}`,
        ...statusLines(status),
        `launchd：${installed ? "已安装" : "未安装"}`,
      ].join("\n"),
    )
  }),
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

const InstallCommand = effectCmd({
  command: "install",
  describe: "write a launchd agent that keeps miao remote running (does not load it)",
  instance: false,
  handler: Effect.fn("Cli.remote.install")(function* () {
    if (process.platform !== "darwin") return yield* fail("目前只支持 macOS（launchd）")
    const { Label, plist } = yield* Effect.promise(() => import("@miao/remote/launchd"))
    const files = paths()
    const file = path.join(files.agents, `${Label}.plist`)
    // A source checkout runs through bun; a compiled binary is its own executable.
    const program = Bun.main.endsWith(".ts")
      ? [process.execPath, "run", Bun.main, "remote"]
      : [process.execPath, "remote"]
    yield* Effect.promise(() => mkdir(files.agents, { recursive: true }))
    yield* Effect.promise(() => mkdir(path.dirname(files.log), { recursive: true }))
    yield* Effect.promise(() =>
      Bun.write(
        file,
        plist({
          program,
          workingDirectory: Global.Path.home,
          logFile: files.log,
          environment: {
            PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: Global.Path.home,
          },
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
})

const UninstallCommand = effectCmd({
  command: "uninstall",
  describe: "remove the launchd agent file (prints the command to unload it)",
  instance: false,
  handler: Effect.fn("Cli.remote.uninstall")(function* () {
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
})

export const RemoteCommand = effectCmd({
  command: "remote",
  describe: "drive sessions from WeChat, QQ, and other IM apps",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(RunCommand)
      .command(LoginCommand)
      .command(StatusCommand)
      .command(InstallCommand)
      .command(UninstallCommand),
  handler: Effect.fn("Cli.remote")(function* () {}),
})

function parseModel(model: string | undefined) {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}
