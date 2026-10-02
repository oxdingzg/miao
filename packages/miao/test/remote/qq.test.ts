// End to end through the QQ channel: a local fake QQ open platform (HTTP and
// WebSocket gateway) stands in for api.bot.qq.com, `miao serve` runs the sessions
// against the fake LLM.
import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createRouter } from "@miao/remote"
import { createQQChannel } from "@miao/remote/connectors/qq/channel"
import { createFakeQQ } from "@miao/remote/connectors/qq/fake-qq"
import { loopbackFetch } from "@miao/remote/testing"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const owner = "OWNER_OPENID"

describe("remote over the QQ channel", () => {
  cliIt.live(
    "replies passively, pushes a late result proactively, and holds it when proactive messages are refused",
    (fixture) =>
      Effect.gen(function* () {
        const alpha = path.join(fixture.home, "alpha")
        yield* Effect.promise(() => mkdir(alpha, { recursive: true }))
        const server = yield* fixture.opencode.serve({
          env: {
            MIAO_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(fixture.llm.url), model: "test/test-model" }),
          },
        })
        const qq = createFakeQQ()
        yield* Effect.addFinalizer(() => Effect.sync(() => qq.stop()))
        const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "remote-qq-e2e-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
        const clock = { offset: 0 }
        const now = () => Date.now() + clock.offset
        const channel = createQQChannel({
          credentials: { appId: qq.appId, secret: qq.secret },
          stateDir: path.join(directory, "qq"),
          owner: () => owner,
          markNeedsLogin: async () => undefined,
          api: qq.url,
          fetch: loopbackFetch,
          now,
        })
        const router = yield* Effect.promise(() =>
          createRouter({
            client: OpenCode.make({ baseUrl: server.url }),
            channels: [{ ...channel, id: `qq/${qq.appId}` }],
            projects: { alpha },
            allow: (_channel, user) => user === owner,
            state: path.join(directory, "router.json"),
            model: { providerID: "test", id: "test-model" },
            now,
          }),
        )
        yield* Effect.promise(() => router.start())
        const texts = () =>
          qq.delivered().flatMap((message) => {
            const text = (message.markdown as { content?: string } | undefined)?.content ?? message.content
            return typeof text === "string" ? [{ text, msgID: message.msg_id }] : []
          })

        const first = Promise.withResolvers<void>()
        yield* fixture.llm.hold("late answer", first.promise)
        yield* Effect.promise(async () => {
          await qq.until(() => qq.connected())
          qq.c2c({ from: "INTRUDER", text: "/new alpha hack", id: "x-1" })
          qq.c2c({ from: owner, text: "/new alpha slow work", id: "in-1" })
          const ack = await qq.until(() => texts().find((item) => item.text.includes("收到，处理中")), 20_000)
          expect(ack.msgID).toBe("in-1")
          await qq.until(() => qq.messages().find((message) => message.msg_type === 6))

          // Long after the passive window, the result still goes out right away, proactively.
          clock.offset = 10 * 60_000
          first.resolve()
          const late = await qq.until(() => texts().find((item) => item.text.includes("late answer")), 20_000)
          expect(late.msgID).toBeUndefined()
          expect(texts().some((item) => item.text.includes("hack"))).toBe(false)
          expect(texts().some((item) => item.text.includes("/r"))).toBe(false)
        })

        const second = Promise.withResolvers<void>()
        yield* fixture.llm.hold("second answer", second.promise)
        yield* Effect.promise(async () => {
          qq.c2c({ from: owner, text: "and one more thing", id: "in-2" })
          await qq.until(() => qq.messages().filter((message) => message.msg_id === "in-2").length > 0, 20_000)
          // The owner switched off proactive messages: the late result is held, not lost.
          clock.offset = 20 * 60_000
          qq.failSend({ err_code: 40054013, message: "用户已拒收消息" })
          second.resolve()
          await qq.until(() => qq.requests.filter((request) => request.path.startsWith("/v2/users/")).length > 0)
          await router.settled()
          expect(texts().some((item) => item.text.includes("second answer"))).toBe(false)

          qq.c2c({ from: owner, text: "/r", id: "in-3" })
          const held = await qq.until(() => texts().find((item) => item.text.includes("second answer")), 20_000)
          expect(held.msgID).toBe("in-3")
        })
        yield* Effect.promise(() => router.stop())
      }),
    90_000,
  )
})
