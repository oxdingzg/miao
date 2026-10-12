import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { translateProviderRequest, translateProviderRequestResult } from "@/engine/bridge"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

const request = (data: unknown, seq = 7) => ({
  session_id: "ses_receipts",
  seq,
  kind: "provider.request",
  data,
  recorded_at_ms: 500,
})

const prepared = {
  run_id: "run_1",
  step: 0,
  context_epoch: 2,
  attempt: 1,
  phase: "prepared",
  protocol: "openai-chat",
  request_body_sha256: "abc123",
  agent: { name: "native-runtime" },
  permissions: { policy: { revision: "r1" } },
  profile: { coverage: "runtime-and-wire" },
}

test("a prepared attempt keeps its native authority and stays out of catalog identity", () => {
  expect(translateProviderRequest(request(prepared))).toMatchObject({
    sessionID: "ses_receipts",
    runID: "run_1",
    step: 0,
    contextEpoch: 2,
    attempt: 1,
    protocol: "openai-chat",
    requestBodySha256: "abc123",
    agent: { name: "native-runtime" },
    permissions: { policy: { revision: "r1" } },
    profile: { coverage: "runtime-and-wire" },
  })
})

test("malformed receipts and wrong event kinds are rejected", () => {
  expect(translateProviderRequest(request({ ...prepared, attempt: 0 }))).toBeUndefined()
  expect(translateProviderRequest(request({ ...prepared, run_id: "" }))).toBeUndefined()
  expect(translateProviderRequest(request({ ...prepared, step: -1 }))).toBeUndefined()
  expect(translateProviderRequest(request({ ...prepared, protocol: "" }))).toBeUndefined()
  expect(translateProviderRequest(request({ ...prepared, request_body_sha256: "" }))).toBeUndefined()
  expect(translateProviderRequest({ ...request(prepared), recorded_at_ms: -1 })).toBeUndefined()
  expect(translateProviderRequest({ ...request(prepared), kind: "message.committed" })).toBeUndefined()
})

test("an attempt outcome never reports an unknown status as success", () => {
  const outcome = (data: unknown, seq = 9) => ({
    session_id: "ses_receipts",
    seq,
    kind: "provider.request.result",
    data,
    recorded_at_ms: 600,
  })
  expect(
    translateProviderRequestResult(
      outcome({ run_id: "run_1", step: 0, request_seq: 7, http_status: 200, outcome: "headers_received" }),
    ),
  ).toMatchObject({ requestSeq: 7, httpStatus: 200, outcome: "headers_received" })
  expect(
    translateProviderRequestResult(
      outcome({ run_id: "run_1", step: 0, request_seq: 7, http_status: null, outcome: "transport_unknown" }),
    ),
  ).toMatchObject({ httpStatus: null, outcome: "transport_unknown" })
  expect(
    translateProviderRequestResult(outcome({ run_id: "run_1", step: 0, request_seq: 7, http_status: -1 })),
  ).toBeUndefined()
  expect(
    translateProviderRequestResult(outcome({ run_id: "run_1", step: 0, request_seq: 0, http_status: 200 })),
  ).toBeUndefined()
  expect(
    translateProviderRequestResult(outcome({ run_id: "run_1", step: 0, request_seq: 99, http_status: 200 })),
  ).toBeUndefined()
})

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "a real native retry delivers each prepared attempt and its observed outcome to the client",
  async () => {
    await using tmp = await tmpdir()
    if (!binary) throw new Error("missing native binary")
    const packets: string[] = []
    const upstream = Bun.serve({
      port: 0,
      async fetch(http) {
        packets.push(await http.text())
        if (packets.length < 3) return new Response("capacity", { status: 503 })
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"RECEIPT_ACK"},"finish_reason":null}]}\n\n',
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
    client.onEvent((event) => {
      if (event.kind === "run.finished") finished.resolve()
    })
    const facade = new EngineSession(client, (event) => outputs.push(event))
    try {
      await facade.prompt("ses_receipts_native", "say it", { inputID: "in_receipts", delivery: "steer" })
      await finished.promise
      const prepared = outputs.filter((event) => event.type === "session.next.provider.request")
      const results = outputs.filter((event) => event.type === "session.next.provider.request.result")
      expect(prepared).toHaveLength(3)
      expect(results).toHaveLength(3)
      expect(packets).toHaveLength(3)
      prepared.forEach((entry, index) => {
        const data = entry.data
        if (typeof data !== "object" || data === null || !("requestBodySha256" in data)) throw new Error("bad receipt")
        expect(data.requestBodySha256).toBe(new Bun.CryptoHasher("sha256").update(packets[index] ?? "").digest("hex"))
        expect(data).toMatchObject({
          sessionID: "ses_receipts_native",
          step: 0,
          attempt: index + 1,
          protocol: "openai-chat",
        })
      })
      expect(
        results.map((entry) => {
          const data = entry.data
          if (typeof data !== "object" || data === null || !("httpStatus" in data)) throw new Error("bad result")
          return data.httpStatus
        }),
      ).toEqual([503, 503, 200])
      // The client receipt correlates to the prepared attempt by its durable source sequence.
      results.forEach((entry, index) => {
        const data = entry.data
        if (typeof data !== "object" || data === null || !("requestSeq" in data)) throw new Error("bad result")
        expect(data.requestSeq).toBe(prepared[index]?.source?.seq)
        expect(JSON.stringify(entry)).not.toContain("fixture-only")
      })
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)
