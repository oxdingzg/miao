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

real(
  "native facade projects each promoted input with its durable queue or steer delivery",
  async () => {
    await using tmp = await tmpdir()
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ACK"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const client = EngineClient.start({
      binary: binary!,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: upstream.url.toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    const outputs: EngineSessionEvent[] = []
    const finished = Promise.withResolvers<void>()
    const timer = setTimeout(() => finished.reject(new Error("native completion did not arrive")), 10000)
    client.onEvent((event) => {
      if (event.kind === "run.finished") finished.resolve()
    })
    const facade = new EngineSession(client, (event) => outputs.push(event))
    try {
      await facade.prompt("ses_delivery", "queued input", { inputID: "in_queue", delivery: "queue", resume: false })
      await facade.prompt("ses_delivery", "steering input", { inputID: "in_steer", delivery: "steer", resume: false })
      await facade.prompt("ses_delivery", "queued input", { inputID: "in_queue", delivery: "queue", resume: true })
      await finished.promise
      const prompts = outputs
        .filter((event) => event.type === "session.next.prompt.admitted")
        .map((event) => BlackboxTape.json(event.data))
      expect(prompts).toHaveLength(2)
      expect(
        Object.fromEntries(
          prompts.map((entry) => {
            if (
              !BlackboxTape.isObject(entry) ||
              !BlackboxTape.isObject(entry.prompt) ||
              typeof entry.prompt.text !== "string"
            )
              throw new Error("missing projected prompt")
            return [entry.prompt.text, entry.delivery]
          }),
        ),
      ).toEqual({ "queued input": "queue", "steering input": "steer" })
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)

real(
  "native restore pages to a captured cursor before readiness and hands later events to live delivery",
  async () => {
    await using tmp = await tmpdir()
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"RESTORED_ACK"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
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
      endpoint: upstream.url.toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    }
    const seed = EngineClient.start(options)
    try {
      for (let index = 0; index < 110; index++)
        await seed.request("mode", { session_id: "ses_restore", mode: index % 2 ? "build" : "plan" })
      const completed = Promise.withResolvers<void>()
      seed.onEvent((event) => {
        if (event.kind === "run.finished") completed.resolve()
      })
      await seed.subscribe("ses_restore")
      await seed.admit({ session_id: "ses_restore", input_id: "in_history", prompt: "historical completed prompt" })
      await completed.promise
      await seed.admit(
        { session_id: "ses_restore", input_id: "in_before", prompt: "before reconnect", delivery: "queue" },
        false,
      )
    } finally {
      await seed.close()
    }
    const client = EngineClient.start(options)
    const outputs: EngineSessionEvent[] = []
    const facade = new EngineSession(client, (event) => outputs.push(event))
    const finished = Promise.withResolvers<void>()
    client.onEvent((event) => {
      if (event.kind === "run.finished") finished.resolve()
    })
    const timer = setTimeout(() => finished.reject(new Error("restored run did not finish")), 10000)
    try {
      const first = facade.restore("ses_restore")
      expect(facade.restore("ses_restore")).toBe(first)
      const snapshot = BlackboxTape.json(await first)
      expect(BlackboxTape.isObject(snapshot) && snapshot.cursor).toBeGreaterThan(110)
      expect(outputs.filter((event) => event.type === "session.next.text.ended")).toHaveLength(1)
      expect(outputs.filter((event) => event.type === "session.next.prompt.admitted")).toHaveLength(1)
      expect(BlackboxTape.json(outputs.find((event) => event.type === "session.next.text.ended")?.data)).toEqual(
        expect.objectContaining({ text: "RESTORED_ACK" }),
      )
      await facade.prompt("ses_restore", "after reconnect", { inputID: "in_after", delivery: "steer" })
      await finished.promise
      const prompts = outputs.filter((event) => event.type === "session.next.prompt.admitted")
      expect(prompts).toHaveLength(3)
      expect(prompts.map((event) => BlackboxTape.json(event.data))).toEqual([
        expect.objectContaining({ delivery: "steer", prompt: { text: "historical completed prompt" } }),
        expect.objectContaining({ delivery: "steer", prompt: { text: "after reconnect" } }),
        expect.objectContaining({ delivery: "queue", prompt: { text: "before reconnect" } }),
      ])
      expect(outputs.filter((event) => event.type === "session.next.text.ended")).toHaveLength(3)
      expect(new Set(outputs.map((event) => JSON.stringify(event.source))).size).toBe(outputs.length)
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)
