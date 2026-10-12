import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { translateRetried } from "@/engine/bridge"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

const fact = (data: unknown, seq = 5) => ({
  session_id: "ses_retry",
  seq,
  kind: "provider.retry",
  data,
  recorded_at_ms: 700,
})

test("a durable retry fact becomes a product retry with its reason", () => {
  expect(
    translateRetried(fact({ run_id: "run_1", step: 0, attempt: 2, reason: "HTTP 503", status: 503 })),
  ).toMatchObject({
    sessionID: "ses_retry",
    attempt: 2,
    error: { message: "HTTP 503", isRetryable: true, statusCode: 503 },
  })
})

test("a retry fact without a status omits the status code", () => {
  expect(translateRetried(fact({ run_id: "run_1", step: 0, attempt: 1, reason: "transport" }))?.error).toEqual({
    message: "transport",
    isRetryable: true,
  })
})

test("foreign and malformed retry facts are dropped", () => {
  expect(translateRetried(fact({ attempt: 0, reason: "x" }))).toBeUndefined()
  expect(translateRetried(fact({ attempt: 1 }))).toBeUndefined()
  expect(translateRetried(fact({ attempt: 1, reason: "" }))).toBeUndefined()
  expect(translateRetried({ ...fact({ attempt: 1, reason: "x" }), kind: "provider.delta" })).toBeUndefined()
  expect(translateRetried({ ...fact({ attempt: 1, reason: "x" }), recorded_at_ms: -1 })).toBeUndefined()
})

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "a real retried attempt is durable and reaches the client with the provider status",
  async () => {
    await using tmp = await tmpdir()
    if (!binary) throw new Error("missing native binary")
    let calls = 0
    const upstream = Bun.serve({
      port: 0,
      async fetch(http) {
        await http.text()
        calls += 1
        if (calls === 1) return new Response("capacity", { status: 503 })
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"RETRY_OK"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: upstream.url.toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    const outputs: EngineSessionEvent[] = []
    const finished = Promise.withResolvers<void>()
    const timer = setTimeout(() => finished.reject(new Error("run did not finish")), 20000)
    client.onEvent((e) => {
      if (e.kind === "stop" || e.kind === "stop_failure") finished.resolve()
    })
    const facade = new EngineSession(client, (e) => outputs.push(e))
    try {
      await facade.prompt("ses_retry_native", "say it", { inputID: "in_retry", delivery: "steer" })
      await finished.promise
      expect(calls).toBe(2)
      const retries = outputs.filter((e) => e.type === "session.next.retried")
      expect(retries).toHaveLength(1)
      expect(retries[0]?.data).toMatchObject({ sessionID: "ses_retry_native", attempt: 1 })
      const data = retries[0]?.data
      if (typeof data !== "object" || data === null || !("error" in data)) throw new Error("bad retry")
      const error = data.error as { message: string; isRetryable: boolean; statusCode?: number }
      expect(error.message.length).toBeGreaterThan(0)
      expect(error.isRetryable).toBe(true)
      expect(error.statusCode).toBe(503)
      // A retry is durable: the recorded fact replays from storage on request.
      const replay = await client.request("events", { session_id: "ses_retry_native", after: 0 })
      const recorded = (replay as { kind?: string; data?: { attempt?: number } }[]).filter(
        (row) => row.kind === "provider.retry",
      )
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.data?.attempt).toBe(1)
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)
