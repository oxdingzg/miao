import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { translateAssistantIdentity } from "@/engine/bridge"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

const event = (data: unknown, kind = "assistant.identity", seq = 7) => ({
  session_id: "ses_identity",
  seq,
  kind,
  data,
  recorded_at_ms: 500,
})

test("assistant identity binds to the committed message by its durable sequence", () => {
  const translated = translateAssistantIdentity(
    event({ assistant_seq: 3, provider: { protocol: "openai-chat", model: "actual" }, agent: null }),
  )
  expect(translated).toMatchObject({
    sessionID: "ses_identity",
    assistantSeq: 3,
    assistantMessageID: "msg_ses_identity_3",
    provider: { protocol: "openai-chat", model: "actual" },
    model: null,
    agent: null,
  })
})

test("unknown provider evidence stays null and malformed evidence is dropped", () => {
  expect(translateAssistantIdentity(event({ assistant_seq: 3, provider: null }))).toMatchObject({ model: null })
  expect(translateAssistantIdentity(event({ assistant_seq: 0, provider: null }))).toBeUndefined()
  expect(translateAssistantIdentity(event({ assistant_seq: 7, provider: null }))).toBeUndefined()
  expect(
    translateAssistantIdentity({ ...event({ assistant_seq: 3, provider: null }), recorded_at_ms: -1 }),
  ).toBeUndefined()

  expect(translateAssistantIdentity(event({ provider: null }))).toBeUndefined()
  expect(
    translateAssistantIdentity(event({ assistant_seq: 3, provider: { protocol: "", model: "actual" } })),
  ).toBeUndefined()
  expect(translateAssistantIdentity(event({ assistant_seq: 3, provider: "openai-chat" }))).toBeUndefined()
  expect(
    translateAssistantIdentity({ ...event({ assistant_seq: 3, provider: null }), kind: "message.committed" }),
  ).toBeUndefined()
})

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "a real native run projects the actual reply identity onto its committed assistant",
  async () => {
    await using tmp = await tmpdir()
    if (!binary) throw new Error("missing native binary")
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"IDENTITY_ACK"},"finish_reason":null}]}\n\n',
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
    const timer = setTimeout(() => finished.reject(new Error("run did not finish")), 10000)
    client.onEvent((event) => {
      if (event.kind === "run.finished") finished.resolve()
    })
    const facade = new EngineSession(client, (event) => outputs.push(event))
    try {
      await facade.prompt("ses_identity_native", "say it", { inputID: "in_identity", delivery: "steer" })
      await finished.promise
      const identity = outputs.filter((event) => event.type === "session.next.assistant.identity")
      expect(identity).toHaveLength(1)
      const assistant = outputs.find((event) => event.type === "session.next.text.ended")
      expect(identity[0].data).toMatchObject({
        sessionID: "ses_identity_native",
        provider: { protocol: "openai-chat", model: "fixture" },
        model: null,
        agent: null,
      })
      const data = identity[0].data
      const text = assistant?.data
      if (
        typeof data !== "object" ||
        data === null ||
        !("assistantMessageID" in data) ||
        typeof text !== "object" ||
        text === null ||
        !("assistantMessageID" in text)
      )
        throw new Error("missing committed assistant")
      expect(data.assistantMessageID).toBe(text.assistantMessageID)
    } finally {
      clearTimeout(timer)
      await client.close()
      upstream.stop(true)
    }
  },
  30000,
)
