// Drives the remote Router against a real `miao serve` subprocess and the fake
// LLM server, through an in-memory channel. Nothing here touches a network
// beyond loopback.
import { describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { createRouter, type Capabilities } from "@miao/remote"
import { createMemoryChannel } from "@miao/remote/memory-channel"
import { Effect } from "effect"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const user = "owner"

function setup(fixture: CliFixture, input: { capabilities?: Partial<Capabilities> } = {}) {
  return Effect.gen(function* () {
    const alpha = path.join(fixture.home, "alpha")
    const beta = path.join(fixture.home, "beta")
    const outside = path.join(fixture.home, "outside")
    yield* Effect.promise(() => Promise.all([alpha, beta, outside].map((dir) => mkdir(dir, { recursive: true }))))
    const server = yield* fixture.opencode.serve({
      env: {
        MIAO_CONFIG_CONTENT: JSON.stringify({
          ...testProviderConfig(fixture.llm.url),
          model: "test/test-model",
          permission: { bash: "ask" },
        }),
      },
    })
    const client = OpenCode.make({ baseUrl: server.url })
    const clock = { offset: 0 }
    const state = path.join(fixture.home, "remote", "router.json")
    const router = (channel: ReturnType<typeof createMemoryChannel>) =>
      createRouter({
        client,
        channels: [channel.channel],
        projects: { alpha, beta },
        allow: { memory: [user] },
        state,
        now: () => Date.now() + clock.offset,
        model: { providerID: "test", id: "test-model" },
      })
    return {
      alpha,
      beta,
      outside,
      client,
      clock,
      router,
      channel: () => createMemoryChannel({ capabilities: input.capabilities }),
    }
  })
}

describe("remote router", () => {
  cliIt.live(
    "lists, creates, drives, approves, interrupts, and keeps its numbering across restarts",
    (fixture) =>
      Effect.gen(function* () {
        const env = yield* setup(fixture)
        const memory = env.channel()
        const router = yield* Effect.promise(() => env.router(memory))
        yield* Effect.promise(() => router.start())

        yield* Effect.promise(async () => {
          await memory.receive("stranger", "/list")
          expect(memory.sent).toEqual([])

          await memory.receive(user, "/projects")
          expect(memory.sent.at(-1)?.text).toContain("alpha →")

          await memory.receive(user, "/new nope")
          expect(memory.sent.at(-1)?.text).toContain("没有这个项目别名：nope")

          await memory.receive(user, "hello")
          expect(memory.sent.at(-1)?.text).toContain("还没有当前会话")
        })

        // A tool call that needs approval, then the final answer.
        yield* fixture.llm.push(reply().tool("bash", { command: "echo remote-ok", description: "Print a marker" }))
        yield* fixture.llm.text("all done")
        yield* Effect.promise(async () => {
          const start = memory.sent.length
          await memory.receive(user, "/new alpha run the tool")
          await memory.next((text) => text.includes("#1 alpha 收到，处理中"), start)
          const ask = await memory.next((text) => text.includes("请求执行 bash"), start)
          expect(ask.text).toContain("echo remote-ok")
          const code = /y(\d+) 允许一次/.exec(ask.text)?.[1]
          expect(code).toBeDefined()
          await memory.receive(user, `y${code}`)
          await memory.next((text) => text === `已允许 ${code}`, start)
          const result = await memory.next((text) => text.startsWith("【#1 alpha】完成"), start)
          expect(result.text).toContain("all done")
          expect(result.text).toContain("工具 1 次")
        })

        // A second session becomes current; "#1 ..." still reaches the first without switching.
        yield* fixture.llm.text("second answer")
        yield* Effect.promise(async () => {
          await memory.receive(user, "/new beta")
          expect(memory.sent.at(-1)?.text).toBe("已新建 #2（beta），已切换为当前会话")
          const start = memory.sent.length
          await memory.receive(user, "#1 one more thing")
          await memory.next((text) => text.includes("#1 alpha 收到，处理中"), start)
          const result = await memory.next((text) => text.startsWith("【#1 alpha】完成"), start)
          expect(result.text).toContain("second answer")
          await memory.receive(user, "/status")
          expect(memory.sent.at(-1)?.text).toContain("【#2 beta】")

          await memory.receive(user, "/list")
          const listing = memory.sent.at(-1)?.text ?? ""
          expect(listing).toContain("#2* beta")
          expect(listing).toContain("#1 alpha")
          await memory.receive(user, "/use 1")
          expect(memory.sent.at(-1)?.text).toContain("当前会话：#1 alpha")
        })

        // The question tool is answered by option number.
        yield* fixture.llm.push(
          reply().tool("question", {
            questions: [
              {
                question: "Which color?",
                header: "Color",
                options: [
                  { label: "Red", description: "warm" },
                  { label: "Blue", description: "cool" },
                ],
              },
            ],
          }),
        )
        yield* fixture.llm.text("picked")
        yield* Effect.promise(async () => {
          const start = memory.sent.length
          await memory.receive(user, "ask me")
          const asked = await memory.next((text) => text.includes("Which color?"), start)
          expect(asked.text).toContain("2. Blue — cool")
          const code = /回复 q(\d+)/.exec(asked.text)?.[1]
          await memory.receive(user, `q${code} 2`)
          await memory.next((text) => text === `已作答 ${code}`, start)
          await memory.next((text) => text.startsWith("【#1 alpha】完成") && text.includes("picked"), start)
          const inputs = await Effect.runPromise(fixture.llm.inputs)
          expect(JSON.stringify(inputs.at(-1))).toContain("Blue")
        })

        // Interrupt a turn that never finishes on its own.
        yield* fixture.llm.hang
        yield* Effect.promise(async () => {
          const start = memory.sent.length
          await memory.receive(user, "keep going")
          await memory.next((text) => text.includes("#1 alpha 收到，处理中"), start)
          await waitFor(async () => Object.keys(await env.client.sessions.active()).length > 0)
          await memory.receive(user, "/stop")
          await memory.next((text) => text === "#1 alpha 已中断", start)
          await memory.next((text) => text.startsWith("【#1 alpha】已中断"), start)
        })

        yield* Effect.promise(() => router.stop())

        // A fresh Router on the same state file keeps numbers and the current session.
        const again = env.channel()
        const restarted = yield* Effect.promise(() => env.router(again))
        yield* Effect.promise(() => restarted.start())
        yield* Effect.promise(async () => {
          await again.receive(user, "/list")
          const listing = again.sent.at(-1)?.text ?? ""
          expect(listing).toContain("#1* alpha")
          expect(listing).toContain("#2 beta")
          await again.receive(user, "/status")
          expect(again.sent.at(-1)?.text).toContain("【#1 alpha】")
          expect(again.sent.at(-1)?.text).toContain("已中断")
        })
        yield* Effect.promise(() => restarted.stop())
      }),
    120_000,
  )

  cliIt.live(
    "holds results outside the reply window, pushes within budget, and refuses sessions it does not own",
    (fixture) =>
      Effect.gen(function* () {
        const env = yield* setup(fixture, {
          capabilities: { replyWindowMs: 120_000, repliesPerInbound: 10, pushBudgetPerDay: 2 },
        })
        // Created before the Router subscribes: from its point of view it was never run here.
        const foreign = yield* Effect.promise(() => env.client.sessions.create({ location: { directory: env.alpha } }))
        yield* Effect.promise(() => env.client.sessions.create({ location: { directory: env.outside } }))
        const memory = env.channel()
        const router = yield* Effect.promise(() => env.router(memory))
        yield* Effect.promise(() => router.start())

        yield* Effect.promise(async () => {
          await memory.receive(user, "/list")
          const listing = memory.sent.at(-1)?.text ?? ""
          expect(listing).toContain("只读")
          expect(listing).not.toContain("outside")
          const number = new RegExp(`#(\\d+)\\S* alpha`).exec(listing)?.[1]
          await memory.receive(user, `#${number} please run`)
          expect(memory.sent.at(-1)?.text).toContain("不在 miao remote 的服务里")
          expect(await env.client.sessions.context({ sessionID: foreign.id })).toEqual([])
        })

        // Turn ends after the window closed: the result is held and a notice is pushed.
        const release = Promise.withResolvers<void>()
        yield* fixture.llm.hold("late answer", release.promise)
        yield* Effect.promise(async () => {
          const start = memory.sent.length
          await memory.receive(user, "/new alpha slow work")
          await memory.next((text) => text.includes("收到，处理中"), start)
          env.clock.offset = 5 * 60_000
          release.resolve()
          const notice = await memory.next((text) => text.includes("这一轮完成，发 /r 取结果"), start)
          expect(notice.text).not.toContain("late answer")
          await router.settled()
          await memory.receive(user, "/r")
          const held = memory.sent.at(-1)?.text ?? ""
          expect(held).toContain("待取结果")
          expect(held).toContain("late answer")
          await memory.receive(user, "/r")
          expect(memory.sent.at(-1)?.text).toBe("没有待取结果")
        })

        // One push left of two: a turn-end notice may not spend the unit reserved for approvals.
        const second = Promise.withResolvers<void>()
        yield* fixture.llm.hold("later answer", second.promise)
        yield* Effect.promise(async () => {
          const start = memory.sent.length
          await memory.receive(user, "again")
          await memory.next((text) => text.includes("收到，处理中"), start)
          env.clock.offset += 5 * 60_000
          second.resolve()
          await router.settled()
          expect(memory.sent.slice(start + 1)).toEqual([])
          await memory.receive(user, "/help")
          const flushed = memory.sent.slice(start + 1).map((message) => message.text)
          expect(flushed[0]).toContain("later answer")
          expect(flushed[1]).toContain("可用命令")
        })
        yield* Effect.promise(() => router.stop())
      }),
    120_000,
  )
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error("condition not met in time")
}
