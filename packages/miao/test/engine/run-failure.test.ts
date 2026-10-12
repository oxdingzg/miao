import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { statusOf, translateRunFailure } from "@/engine/bridge"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

const event = (data: unknown, kind = "stop_failure", seq = 9) => ({
  session_id: "ses_failure",
  seq,
  kind,
  data,
  recorded_at_ms: 500,
})

test("a native lifecycle failure becomes a product drain failure", () => {
  expect(translateRunFailure(event({ run_id: "run_1", reason: "provider rejected the request" }))).toMatchObject({
    sessionID: "ses_failure",
    error: { type: "unknown", message: "provider rejected the request" },
    name: "EngineRunFailed",
  })
})

test("the recorded error text is preferred over the coarse lifecycle category", () => {
  expect(
    translateRunFailure(event({ run_id: "run_1", reason: "failed", message: "HTTP 400: rejected by fixture" })),
  ).toMatchObject({ error: { type: "unknown", message: "HTTP 400: rejected by fixture" } })
  expect(translateRunFailure(event({ run_id: "run_1", reason: "failed", message: null }))).toMatchObject({
    error: { type: "unknown", message: "failed" },
  })
})

test("malformed or foreign lifecycle facts are dropped", () => {
  expect(translateRunFailure(event({ run_id: "run_1" }))).toBeUndefined()
  expect(translateRunFailure(event({ run_id: "run_1", reason: "" }))).toBeUndefined()
  expect(translateRunFailure(event({ run_id: "run_1", reason: 7 }))).toBeUndefined()
  expect(translateRunFailure({ ...event({ run_id: "run_1", reason: "x" }), recorded_at_ms: -1 })).toBeUndefined()
  expect(translateRunFailure({ ...event({ run_id: "run_1", reason: "x" }), kind: "stop" })).toBeUndefined()
})

test("the lifecycle stop settles the client status even without run.finished", () => {
  expect(statusOf(event({ run_id: "run_1", reason: "x" }))).toEqual({ type: "idle" })
  expect(statusOf(event({ run_id: "run_1" }, "stop"))).toEqual({ type: "idle" })
  expect(statusOf(event({ run_id: "run_1" }, "run.started"))).toEqual({ type: "busy" })
})

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "a native drain the provider rejects reaches the client as a failure",
  async () => {
    await using tmp = await tmpdir()
    if (!binary) throw new Error("missing native binary")
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: { message: "rejected by fixture" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
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
      await facade.prompt("ses_failure_native", "say it", { inputID: "in_failure", delivery: "steer" })
      await finished.promise
      const failures = outputs.filter((e) => e.type === "session.next.failed")
      expect(failures).toHaveLength(1)
      expect(failures[0]?.data).toMatchObject({ sessionID: "ses_failure_native", error: { type: "unknown" } })
      const data = failures[0]?.data
      if (typeof data !== "object" || data === null || !("error" in data)) throw new Error("bad failure")
      // The message is the provider error, not the bare `failed` category.
      expect((data.error as { message: string }).message).not.toBe("failed")
      expect((data.error as { message: string }).message.length).toBeGreaterThan(0)
      // The lifecycle stop also settles the status, so the client is not left busy.
      expect(outputs.filter((e) => e.type === "session.next.status").at(-1)?.data).toMatchObject({
        status: { type: "idle" },
      })
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)
