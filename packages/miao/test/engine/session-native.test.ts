import { expect, test } from "bun:test"
import path from "node:path"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { EngineClient, EngineError, type EngineEvent } from "@/engine/client"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { runEnginePrompt } from "@/engine/run"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "native façade preserves admission identity and coalesces concurrent history subscriptions",
  async () => {
    await using tmp = await tmpdir()
    let requests = 0
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "SEEDED" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const options = {
      binary: binary!,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("/chat/completions", upstream.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    }
    const sessionID = "ses_facade_retry"
    try {
      const seed = await runEnginePrompt({
        ...options,
        session: sessionID,
        inputId: "in_seed",
        prompt: "seed",
        timeoutMs: 15000,
      })
      expect(seed.text).toBe("SEEDED")
      const last = Math.max(...seed.events.map((event) => event.seq))
      const client = EngineClient.start(options)
      const raw: EngineEvent[] = []
      const published: EngineSessionEvent[] = []
      const checkpoint = Promise.withResolvers<void>()
      const timer = setTimeout(() => checkpoint.reject(new Error("history checkpoint did not arrive")), 5000)
      let subscriptions = 0
      const subscribe = client.subscribe
      client.subscribe = (session, after) => {
        subscriptions++
        return subscribe.call(client, session, after)
      }
      client.onEvent((event) => {
        raw.push(event)
        if (event.seq === last) checkpoint.resolve()
      })
      const facade = new EngineSession(client, (event) => published.push(event))
      try {
        const admissions = await Promise.all([
          facade.prompt(sessionID, "first", { inputID: "in_first", delivery: "queue", resume: false }),
          facade.prompt(sessionID, "second", { inputID: "in_second", delivery: "steer", resume: false }),
        ])
        // Stdio acknowledges subscription before its next durable-event poll.
        await checkpoint.promise
        expect(subscriptions).toBe(1)
        const history = raw.filter((event) => event.seq <= last)
        expect(history.length).toBeGreaterThan(0)
        expect(new Set(history.map((event) => event.seq)).size).toBe(history.length)
        expect(published.filter((event) => event.type === "session.next.text.ended")).toHaveLength(1)
        const original = BlackboxTape.json(admissions[0])
        const retry = BlackboxTape.json(
          await facade.prompt(sessionID, "first", { inputID: "in_first", delivery: "queue", resume: false }),
        )
        if (!BlackboxTape.isObject(original) || !BlackboxTape.isObject(retry))
          throw new Error("missing admission receipts")
        expect(retry.admitted_seq).toBe(original.admitted_seq)
        expect(Number.isSafeInteger(retry.admitted_seq)).toBe(true)
        await expect(
          facade.prompt(sessionID, "changed", { inputID: "in_first", delivery: "queue", resume: false }),
        ).rejects.toBeInstanceOf(EngineError)
        await expect(
          facade.prompt(sessionID, "first", { inputID: "in_first", delivery: "steer", resume: false }),
        ).rejects.toBeInstanceOf(EngineError)
        await expect(
          facade.prompt("ses_other", "first", { inputID: "in_first", delivery: "queue", resume: false }),
        ).rejects.toBeInstanceOf(EngineError)
        expect(requests).toBe(1)
      } finally {
        clearTimeout(timer)
        await client.close()
      }
    } finally {
      upstream.stop(true)
    }
  },
  30000,
)
