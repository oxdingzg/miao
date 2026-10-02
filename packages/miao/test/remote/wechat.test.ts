// End to end through the WeChat channel: a local fake iLink server stands in for
// ilinkai.weixin.qq.com, `miao serve` runs the sessions against the fake LLM.
import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createRouter } from "@miao/remote"
import { createWechatChannel } from "@miao/remote/wechat/channel"
import { createFakeIlink, textMessage } from "@miao/remote/wechat/fake-ilink"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const owner = "owner@im.wechat"

const localOnly = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "127.0.0.1") throw new Error(`test attempted a non-loopback request: ${url}`)
    return fetch(input, init)
  },
  { preconnect: () => undefined },
) satisfies typeof fetch

describe("remote over the WeChat channel", () => {
  cliIt.live(
    "ignores strangers, acknowledges in the window, and holds a late result until the next message",
    (fixture) =>
      Effect.gen(function* () {
        const alpha = path.join(fixture.home, "alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
        const server = yield* fixture.opencode.serve({
          env: {
            MIAO_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(fixture.llm.url), model: "test/test-model" }),
          },
        })
        const ilink = createFakeIlink()
        yield* Effect.addFinalizer(() => Effect.sync(() => ilink.stop()))
        const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "remote-wechat-e2e-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
        const clock = { offset: 0 }
        const wechat = createWechatChannel({
          credentials: { token: "bot-token", botID: "bot@im.bot", baseUrl: ilink.url, userID: owner, savedAt: 0 },
          stateDir: path.join(directory, "state"),
          authFile: path.join(directory, "auth.json"),
          agentVersion: "test",
          fetch: localOnly,
          typingIntervalMs: 50,
        })
        const router = yield* Effect.promise(() =>
          createRouter({
            client: OpenCode.make({ baseUrl: server.url }),
            channels: [wechat],
            projects: { alpha },
            allow: { wechat: [owner] },
            state: path.join(directory, "state", "router.json"),
            model: { providerID: "test", id: "test-model" },
            now: () => Date.now() + clock.offset,
          }),
        )
        yield* Effect.promise(() => router.start())
        const texts = () => ilink.sent().map((message) => message.item_list[0].text_item.text)

        const release = Promise.withResolvers<void>()
        yield* fixture.llm.hold("late answer", release.promise)
        yield* Effect.promise(async () => {
          ilink.update({ msgs: [textMessage({ from: "intruder@im.wechat", text: "/new alpha hack" })], buf: "b1" })
          ilink.update({
            msgs: [textMessage({ from: owner, text: "/new alpha slow work", context: "ctx-1" })],
            buf: "b2",
          })
          const ack = await ilink.until(
            (request) =>
              request.path === "/ilink/bot/sendmessage" && JSON.stringify(request.body).includes("收到，处理中"),
            20_000,
          )
          expect((ack.body.msg as { context_token?: string }).context_token).toBe("ctx-1")
          await ilink.until((request) => request.path === "/ilink/bot/sendtyping")

          // The turn ends after the two-minute reply window has closed.
          clock.offset = 5 * 60_000
          release.resolve()
          await waitFor(() => texts().some((text) => text.includes("发 /r 取结果")))
          await router.settled()
          expect(texts().some((text) => text.includes("late answer"))).toBe(false)
          expect(texts().some((text) => text.includes("hack"))).toBe(false)

          // The next inbound message opens a new window and carries the held result.
          ilink.update({ msgs: [textMessage({ from: owner, text: "/r", context: "ctx-2" })], buf: "b3" })
          await waitFor(() => texts().some((text) => text.includes("late answer")))
          const delivered = ilink.sent().find((message) => message.item_list[0].text_item.text.includes("late answer"))
          expect(delivered?.context_token).toBe("ctx-2")
          expect(
            await router.settled().then(() => ilink.sent().filter((message) => message.to_user_id !== owner)),
          ).toEqual([])
        })
        yield* Effect.promise(() => router.stop())
      }),
    90_000,
  )
})

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error("condition not met in time")
}
