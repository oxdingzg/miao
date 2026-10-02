// The `miao remote` daemon's control routes and the login command, against a
// local fake QQ open platform. No real IM host, launchd, or user data is touched.
import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createFakeQQ } from "@miao/remote/connectors/qq/fake-qq"
import { createFakeIlink } from "@miao/remote/connectors/wechat/fake-ilink"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const owner = "OWNER_OPENID"

describe("miao remote daemon", () => {
  cliIt.live(
    "starts with no account, and a login through the control route joins the running Router at once",
    ({ home, llm }) =>
      Effect.gen(function* () {
        const qq = createFakeQQ()
        yield* Effect.addFinalizer(() => Effect.sync(() => qq.stop()))
        const alpha = path.join(home, "alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
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
        const child = yield* daemon(home, { MIAO_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)) })
        const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` })
        const stderr = new Response(child.stderr).text()

        yield* Effect.promise(async () => {
          const status = await ready(client, child)
          expect(status.pid).toBe(child.pid)
          expect(status.connectors.map((connector) => connector.id)).toEqual(["wechat", "qq"])
          expect(status.connectors.flatMap((connector) => connector.accounts)).toEqual([])

          qq.autoBind = owner
          const flow = await client.remote.login({ connector: "qq" })
          const steps = []
          for await (const step of client.remote.loginEvents({ flow: flow.flow })) steps.push(step)
          expect(steps.at(-1)).toMatchObject({ type: "done", connector: "qq", account: { id: qq.appId } })

          // No restart: the new channel connects inside the running daemon and the owner is answered.
          await qq.until(() => qq.connected(), 30_000)
          const account = (await client.remote.get()).connectors[1].accounts[0]
          expect(account).toMatchObject({ connector: "qq", account: qq.appId, owner: "OWNE…OPENID" })
          expect(["connected", "connecting"]).toContain(account.state)
          qq.c2c({ from: owner, text: "/help", id: "help-1" })
          await qq.until(() => qq.delivered().find((message) => message.msg_id === "help-1"), 20_000)
        })

        child.kill("SIGTERM")
        expect(yield* Effect.promise(() => child.exited)).toBe(0)
        expect(yield* Effect.promise(() => stderr)).toContain("还没有登录任何 IM")
      }),
    180_000,
  )

  cliIt.live(
    "keeps serving with only an expired (-14) login and never polls it",
    ({ home, llm }) =>
      Effect.gen(function* () {
        const ilink = createFakeIlink()
        yield* Effect.addFinalizer(() => Effect.sync(() => ilink.stop()))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".local/share/miao/remote-auth.json"),
            JSON.stringify({
              wechat: {
                token: "t",
                botID: "bot@im.bot",
                baseUrl: ilink.url,
                userID: "owner@im.wechat",
                savedAt: 0,
                needsLogin: { at: 1, reason: "iLink returned -14" },
              },
            }),
          ),
        )
        const port = yield* Effect.promise(freePort)
        yield* Effect.promise(() =>
          Bun.write(path.join(home, ".config/miao/miao.json"), JSON.stringify({ remote: { port } })),
        )
        const child = yield* daemon(home, { MIAO_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)) })
        const stderr = new Response(child.stderr).text()
        const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}` })
        yield* Effect.promise(async () => {
          const status = await ready(client, child)
          expect(status.connectors[0].accounts[0]).toMatchObject({ account: "bot@im.bot", state: "needs-login" })
          await Bun.sleep(1000)
          expect(ilink.requests).toEqual([])
        })
        child.kill("SIGTERM")
        expect(yield* Effect.promise(() => child.exited)).toBe(0)
        expect(yield* Effect.promise(() => stderr)).toContain("重新扫码")
      }),
    120_000,
  )

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
        const child = yield* daemon(home, env)
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

/**
 * `miao remote` in an isolated home, stopped with SIGTERM when the scope closes.
 * The remote package's preload makes any request beyond 127.0.0.1 throw in the child.
 */
function daemon(home: string, env: Record<string, string>) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        [
          "bun",
          "run",
          "--preload",
          path.resolve(import.meta.dir, "../../../remote/test/preload.ts"),
          path.resolve(import.meta.dir, "../../src/index.ts"),
          "remote",
        ],
        {
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
        },
      ),
    ),
    (process) =>
      Effect.promise(async () => {
        process.kill("SIGTERM")
        await process.exited
      }),
  )
}

/** Waits until the daemon answers its control route. */
async function ready(client: ReturnType<typeof OpenCode.make>, child: { readonly exitCode: number | null }) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`miao remote exited with ${child.exitCode}`)
    const status = await client.remote.get({ signal: AbortSignal.timeout(2000) }).catch(() => undefined)
    if (status) return status
    await Bun.sleep(200)
  }
  throw new Error("miao remote did not answer within 60s")
}

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
