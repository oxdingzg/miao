import type { Argv } from "yargs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
import { InstallationVersion } from "@miao/core/installation/version"
import { effectCmd, fail } from "../effect-cmd"

const DefaultPort = 4097

// Credentials sit next to auth.json and mcp-auth.json but in their own file, so a
// bot token is never read as a provider key. Cursor, router state, and the lock
// live under the state directory.
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

const RunCommand = effectCmd({
  command: "$0",
  describe: "run the miao server with the logged-in IM channels (foreground)",
  instance: false,
  handler: Effect.fn("Cli.remote.run")(function* () {
    const { loadCredentials } = yield* Effect.promise(() => import("@miao/remote/wechat/login"))
    const files = paths()
    const credentials = yield* Effect.promise(() => loadCredentials(files.auth))
    if (!credentials) return yield* fail("还没有登录任何 IM：先运行 miao remote login wechat")
    // Exit 0 so the launchd agent (KeepAlive on failure only) does not restart into the same dead token.
    if (credentials.needsLogin) {
      console.error("微信登录已失效（iLink -14），请运行 miao remote login wechat 重新扫码")
      return
    }
    const config = yield* loadRemoteConfig()
    const projects = config.remote.projects ?? {}
    if (Object.keys(projects).length === 0)
      console.error("提示：配置里没有 remote.projects，微信里将看不到也建不了任何会话")
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
    const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`)

    const { OpenCode } = yield* Effect.promise(() => import("@miao/client"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const { createRouter } = yield* Effect.promise(() => import("@miao/remote"))
    const { createWechatChannel } = yield* Effect.promise(() => import("@miao/remote/wechat/channel"))
    const wechat = createWechatChannel({
      credentials,
      stateDir: files.state,
      authFile: files.auth,
      agentVersion: InstallationVersion,
      pushBudgetPerDay: config.remote.wechat?.push_budget_per_day,
      log,
    })
    const router = yield* Effect.promise(() =>
      createRouter({
        client: OpenCode.make({ baseUrl: url, headers: ServerAuth.headers() }),
        channels: [wechat],
        projects,
        allow: { wechat: [credentials.userID] },
        state: path.join(files.state, "router.json"),
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
    console.log(`miao remote 已启动：微信 bot ${credentials.botID}，服务 ${url}`)
    console.log(`桌面查看或操作这些会话：${attach}`)

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve())
          process.once("SIGTERM", () => resolve())
        }),
    )
    yield* Effect.promise(() => router.stop())
    yield* Effect.promise(() => server.stop(true))
  }),
})

const LoginCommand = effectCmd({
  command: "login <channel>",
  describe: "log in to an IM channel (scan a QR code)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("channel", { type: "string", choices: ["wechat"], demandOption: true, describe: "IM channel" }),
  handler: Effect.fn("Cli.remote.login")(function* () {
    const { createLoginApi } = yield* Effect.promise(() => import("@miao/remote/wechat/ilink"))
    const { login, loadCredentials, saveCredentials } = yield* Effect.promise(() => import("@miao/remote/wechat/login"))
    const { renderUnicodeCompact } = yield* Effect.promise(() => import("uqr"))
    const { createInterface } = yield* Effect.promise(() => import("node:readline/promises"))
    const files = paths()
    console.log(
      [
        "风险提示：腾讯没有明确允许或禁止第三方客户端使用微信 ClawBot（iLink）。目前没有因此封微信号的报告，",
        "但有 bot 下行消息被风控、几天到三周才恢复的报告。miao 会把每天的主动推送控制在配置的预算内。",
        "",
        "用手机微信扫描下面的二维码：",
      ].join("\n"),
    )
    const result = yield* Effect.promise(() =>
      login({
        api: createLoginApi({}),
        show: (content) => {
          console.log(renderUnicodeCompact(content, { border: 1 }))
          console.log(`二维码显示不全时，用微信打开这个链接：${content}`)
        },
        ask: async (prompt) => {
          const reader = createInterface({ input: process.stdin, output: process.stdout })
          const answer = await reader.question(prompt)
          reader.close()
          return answer
        },
        say: (message) => console.log(message),
      }),
    )
    if (!result.ok) {
      if (result.alreadyBound && (yield* Effect.promise(() => loadCredentials(files.auth)))) {
        console.log(result.message)
        return
      }
      return yield* fail(result.message)
    }
    yield* Effect.promise(() => saveCredentials(files.auth, result.credentials))
    console.log(`已登录微信 bot ${result.credentials.botID}，只接受扫码者本人的消息。凭证保存在 ${files.auth}（0600）`)
    console.log("运行 miao remote 启动；如果它已经在运行，请重启它以使用新凭证")
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show channel login, polling state, today's push usage, and held results",
  instance: false,
  handler: Effect.fn("Cli.remote.status")(function* () {
    const { loadCredentials } = yield* Effect.promise(() => import("@miao/remote/wechat/login"))
    const { statePaths } = yield* Effect.promise(() => import("@miao/remote/wechat/channel"))
    const { lockHolder } = yield* Effect.promise(() => import("@miao/remote/lock"))
    const { readJson } = yield* Effect.promise(() => import("@miao/remote/file"))
    const { routerStatus } = yield* Effect.promise(() => import("@miao/remote"))
    const { Label } = yield* Effect.promise(() => import("@miao/remote/launchd"))
    const files = paths()
    const config = yield* loadRemoteConfig()
    const credentials = yield* Effect.promise(() => loadCredentials(files.auth))
    const lines = [`服务端口：127.0.0.1:${config.remote.port ?? DefaultPort}`]
    if (!credentials) lines.push("微信：未登录（miao remote login wechat）")
    if (credentials) {
      const state = statePaths(files.state, credentials.botID)
      const holder = yield* Effect.promise(() => lockHolder(state.lock))
      const status = (yield* Effect.promise(() => readJson(state.status))) as
        | { state?: string; lastPollAt?: number; error?: string }
        | undefined
      lines.push(
        `微信：bot ${credentials.botID}，扫码者 ${mask(credentials.userID)}` +
          (credentials.needsLogin ? `，登录已失效（${credentials.needsLogin.reason}），请重新登录` : ""),
        `轮询：${holder ? `运行中（pid ${holder}）` : "未运行"}` +
          (status?.state ? `，最近状态 ${status.state}` : "") +
          (status?.lastPollAt ? `，上次成功轮询 ${new Date(status.lastPollAt).toLocaleString()}` : "") +
          (status?.error ? `，最近错误 ${status.error}` : ""),
      )
    }
    const budget = config.remote.wechat?.push_budget_per_day ?? 4
    const users = yield* Effect.promise(() => routerStatus(path.join(files.state, "router.json")))
    users.forEach((user) =>
      lines.push(
        `${mask(user.key)}：今日主动推送 ${user.pushesToday}/${budget}，待取结果 ${user.pending} 条，待审批 ${user.approvals} 个` +
          (user.current === undefined ? "" : `，当前会话 #${user.current}`),
      ),
    )
    const installed = yield* Effect.promise(() => Bun.file(path.join(files.agents, `${Label}.plist`)).exists())
    lines.push(`launchd：${installed ? "已安装" : "未安装"}`)
    console.log(lines.join("\n"))
  }),
})

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
  describe: "drive sessions from WeChat (and later other IM apps)",
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

function mask(value: string) {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-6)}`
}
