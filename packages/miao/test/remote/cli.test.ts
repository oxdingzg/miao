// `miao remote` subcommands in an isolated home: no real IM service, launchd,
// or user data is touched. The long-running test points the WeChat channel at a
// local fake iLink server through the saved credentials' base URL.
import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createFakeIlink, textMessage } from "@miao/remote/wechat/fake-ilink"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const owner = "owner@im.wechat"

describe("miao remote command", () => {
  cliIt.live(
    "reports status, refuses to run without a login, and writes the launchd agent without loading it",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const status = yield* opencode.spawn(["remote", "status"])
        opencode.expectExit(status, 0, "remote status")
        expect(status.stdout).toContain("微信：未登录")
        expect(status.stdout).toContain("服务端口：127.0.0.1:4097")

        const run = yield* opencode.spawn(["remote"])
        expect(run.exitCode).toBe(1)
        expect(run.stderr).toContain("miao remote login wechat")

        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".local/share/miao/remote-auth.json"),
            JSON.stringify({
              wechat: {
                token: "t",
                botID: "bot@im.bot",
                baseUrl: "http://127.0.0.1:9",
                userID: owner,
                savedAt: 0,
                needsLogin: { at: 1, reason: "iLink returned -14" },
              },
            }),
          ),
        )
        const expired = yield* opencode.spawn(["remote"])
        opencode.expectExit(expired, 0, "remote with an expired login")
        expect(expired.stderr).toContain("重新扫码")

        if (process.platform !== "darwin") return
        const install = yield* opencode.spawn(["remote", "install"])
        opencode.expectExit(install, 0, "remote install")
        const file = path.join(home, "Library/LaunchAgents/dev.mtty.miao.remote.plist")
        expect(install.stdout).toContain(`launchctl bootstrap gui/${process.getuid?.()} ${file}`)
        const plist = yield* Effect.promise(() => Bun.file(file).text())
        expect(plist).toContain("<string>remote</string>")
        expect(plist).not.toContain("MIAO_SERVER_PASSWORD")
        const installed = yield* opencode.spawn(["remote", "status"])
        expect(installed.stdout).toContain("launchd：已安装")

        const uninstall = yield* opencode.spawn(["remote", "uninstall"])
        opencode.expectExit(uninstall, 0, "remote uninstall")
        expect(uninstall.stdout).toContain(`launchctl bootout gui/${process.getuid?.()}/dev.mtty.miao.remote`)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "runs the server on the configured loopback port with the WeChat channel and a single-instance lock",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const ilink = createFakeIlink()
        yield* Effect.addFinalizer(() => Effect.sync(() => ilink.stop()))
        const alpha = path.join(home, "alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".local/share/miao/remote-auth.json"),
            JSON.stringify({
              wechat: { token: "bot-token", botID: "bot@im.bot", baseUrl: ilink.url, userID: owner, savedAt: 0 },
            }),
          ),
        )
        const port = yield* Effect.promise(freePort)
        // `miao remote` reads its own settings from the global config file, like `miao serve` does.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".config/miao/miao.json"),
            JSON.stringify({ model: "test/test-model", remote: { port, projects: { alpha } } }),
          ),
        )
        const env = { MIAO_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)) }
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn(["bun", "run", path.resolve(import.meta.dir, "../../src/index.ts"), "remote"], {
              cwd: home,
              env: {
                ...process.env,
                HOME: home,
                PWD: home,
                MIAO_TEST_HOME: home,
                XDG_CONFIG_HOME: path.join(home, ".config"),
                XDG_DATA_HOME: path.join(home, ".local/share"),
                XDG_STATE_HOME: path.join(home, ".local/state"),
                XDG_CACHE_HOME: path.join(home, ".cache"),
                MIAO_DISABLE_PROJECT_CONFIG: "1",
                MIAO_PURE: "1",
                MIAO_DISABLE_AUTOUPDATE: "1",
                MIAO_DISABLE_MODELS_FETCH: "1",
                MIAO_AUTH_CONTENT: "{}",
                ...env,
              },
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
          (process) =>
            Effect.promise(async () => {
              process.kill("SIGTERM")
              await process.exited
            }),
        )
        const stdout = new Response(child.stdout).text()

        yield* llm.text("hello from remote")
        yield* Effect.promise(async () => {
          await ilink.until((request) => request.path === "/ilink/bot/getupdates", 30_000)
          const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` })
          expect(await client.health.get()).toBeDefined()

          ilink.update({
            msgs: [textMessage({ from: owner, text: "/new alpha say hello", context: "ctx-1" })],
            buf: "b1",
          })
          await ilink.until(
            (request) =>
              request.path === "/ilink/bot/sendmessage" && JSON.stringify(request.body).includes("hello from remote"),
            30_000,
          )
        })

        const second = yield* opencode.spawn(["remote"], { env })
        expect(second.exitCode).toBe(1)
        expect(second.stderr).toMatch(/端口被占用|另一个 miao remote/)

        const status = yield* opencode.spawn(["remote", "status"], { env })
        opencode.expectExit(status, 0, "remote status while running")
        expect(status.stdout).toContain(`服务端口：127.0.0.1:${port}`)
        expect(status.stdout).toMatch(/轮询：运行中（pid \d+）/)
        expect(status.stdout).toContain("今日主动推送 0/4")

        child.kill("SIGTERM")
        expect(yield* Effect.promise(() => child.exited)).toBe(0)
        expect(yield* Effect.promise(() => stdout)).toContain(`miao attach http://127.0.0.1:${port}`)
        const after = yield* opencode.spawn(["remote", "status"], { env })
        expect(after.stdout).toContain("轮询：未运行")
      }),
    180_000,
  )
})

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}
