// The `miao remote` daemon's control routes and the login command, against a
// local fake QQ open platform. No real IM host, launchd, or user data is touched.
import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createFakeQQ } from "@miao/remote/connectors/qq/fake-qq"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const owner = "OWNER_OPENID"

describe("miao remote daemon", () => {
  cliIt.live(
    "logs in to QQ in this process when no daemon runs, then reports the account",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const qq = createFakeQQ()
        yield* Effect.addFinalizer(() => Effect.sync(() => qq.stop()))
        qq.autoBind = owner
        const port = yield* Effect.promise(freePort)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".config/miao/miao.json"),
            JSON.stringify({ remote: { port, qq: { portal: qq.url, api: qq.url } } }),
          ),
        )
        const login = yield* opencode.spawn(["remote", "login", "qq"])
        opencode.expectExit(login, 0, "remote login qq")
        expect(login.stdout).toContain(`已连接QQ 机器人（${qq.appId}）`)
        expect(login.stdout).toContain(`${qq.url}/qqbot/openclaw/connect.html?task_id=task-1&source=miao&_wv=2`)
        const saved = (yield* Effect.promise(() =>
          Bun.file(path.join(home, ".local/share/miao/remote-auth.json")).json(),
        )) as { qq: Record<string, { owner: string; credentials: { appId: string; secret: string } }> }
        expect(saved.qq[qq.appId]).toMatchObject({ owner, credentials: { appId: qq.appId, secret: qq.secret } })

        const status = yield* opencode.spawn(["remote", "status"])
        opencode.expectExit(status, 0, "remote status")
        expect(status.stdout).toContain("守护进程：未运行")
        expect(status.stdout).toContain(`QQ 机器人：${qq.appId}，主人 OWNE…OPENID`)
        expect(status.stdout).toContain("连接：未运行")
        expect(status.stdout).toContain("微信：未登录（miao remote login wechat）")
      }),
    120_000,
  )

  cliIt.live(
    "serves control routes only in remote mode and logs in, tests, and disconnects through them",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const qq = createFakeQQ()
        yield* Effect.addFinalizer(() => Effect.sync(() => qq.stop()))
        const alpha = path.join(home, "alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".local/share/miao/remote-auth.json"),
            JSON.stringify({
              qq: {
                [qq.appId]: {
                  label: "QQ 机器人",
                  owner,
                  savedAt: 0,
                  credentials: { appId: qq.appId, secret: qq.secret },
                },
              },
            }),
          ),
        )
        const port = yield* Effect.promise(freePort)
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".config/miao/miao.json"),
            JSON.stringify({
              model: "test/test-model",
              remote: { port, projects: { alpha }, qq: { portal: qq.url, api: qq.url } },
            }),
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
        const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` })

        yield* Effect.promise(async () => {
          await qq.until(() => qq.connected(), 30_000)
          const status = await client.remote.get()
          expect(status.pid).toBe(child.pid)
          expect(status.port).toBe(port)
          expect(status.connectors.map((connector) => connector.id)).toEqual(["wechat", "qq"])
          const account = status.connectors[1].accounts[0]
          expect(account).toMatchObject({ connector: "qq", account: qq.appId, owner: "OWNE…OPENID" })
          expect(["connected", "connecting"]).toContain(account.state)

          // The account is live: the owner's message reaches the Router and gets an answer.
          qq.c2c({ from: owner, text: "/help", id: "help-1" })
          await qq.until(() => qq.delivered().find((message) => message.msg_id === "help-1"), 20_000)

          expect(await client.remote.test({ connector: "qq", account: qq.appId })).toEqual({ ok: true, sent: 1 })
          expect(
            await client.remote.pair({ connector: "qq", account: qq.appId }).then(
              () => "paired",
              (error: { _tag?: string; message?: string }) => error._tag,
            ),
          ).toBe("InvalidRequestError")
          expect(
            await client.remote.test({ connector: "qq", account: "nope" }).then(
              () => "sent",
              (error: { _tag?: string }) => error._tag,
            ),
          ).toBe("RemoteNotFoundError")
        })

        // `miao remote login` goes through the running daemon, and the new login replaces the live channel.
        qq.autoBind = "NEW_OWNER"
        const identified = qq.frames.filter((frame) => frame.op === 2 || frame.op === 6).length
        const login = yield* opencode.spawn(["remote", "login", "qq"], { env })
        opencode.expectExit(login, 0, "remote login qq through the daemon")
        expect(login.stdout).toContain(`通过正在运行的 miao remote（pid ${child.pid}）登录`)
        expect(login.stdout).toContain(`已连接QQ 机器人（${qq.appId}）`)
        yield* Effect.promise(async () => {
          await qq.until(
            () => qq.frames.filter((frame) => frame.op === 2 || frame.op === 6).length > identified || undefined,
            20_000,
          )
          const status = await client.remote.get()
          expect(status.connectors[1].accounts[0].owner).toBe("NEW_…_OWNER")

          qq.autoBind = undefined
          const flow = await client.remote.login({ connector: "qq" })
          await client.remote.loginCancel({ flow: flow.flow })
          const steps = []
          for await (const step of client.remote.loginEvents({ flow: flow.flow })) steps.push(step.type)
          expect(steps.at(-1)).toBe("error")

          await client.remote.remove({ connector: "qq", account: qq.appId })
          expect((await client.remote.get()).connectors[1].accounts).toEqual([])
        })

        const status = yield* opencode.spawn(["remote", "status"], { env })
        expect(status.stdout).toContain(`守护进程：运行中（pid ${child.pid}`)
        expect(status.stdout).toContain("QQ 机器人：未登录（miao remote login qq）")

        // A plain `miao serve` has no remote control.
        const server = yield* opencode.serve({ env })
        const plain = yield* Effect.promise(() =>
          OpenCode.make({ baseUrl: server.url })
            .remote.get()
            .then(
              () => "served",
              (error: { _tag?: string }) => error._tag,
            ),
        )
        expect(plain).toBe("RemoteNotFoundError")
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
