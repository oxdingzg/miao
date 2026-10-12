import { expect, test } from "bun:test"
import path from "node:path"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { EngineClient } from "@/engine/client"
import { EngineWireProfile } from "@/engine/wire-profile"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const native = binary ? test : test.skip

const cases = [
  {
    provider: "openai-chat",
    path: "/chat/completions",
    frames: [
      { choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ],
  },
  {
    provider: "openai-responses",
    path: "/responses",
    frames: [
      { type: "response.created", response: { id: "response-fixture" } },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        },
      },
    ],
  },
  {
    provider: "anthropic",
    path: "/messages",
    frames: [
      {
        type: "message_start",
        message: { id: "message-fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 1 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  },
  {
    provider: "gemini",
    path: "/v1beta/models/actual-wire-model:streamGenerateContent",
    frames: [{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }],
  },
] as const

cases.forEach((entry) =>
  native(
    `actual native ${entry.provider} retries bind runtime authority to every HTTP packet and survive reopen`,
    async () => {
      if (!binary) throw new Error("native binary required")
      await using tmp = await tmpdir()
      const packets: string[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          packets.push(await request.text())
          if (packets.length < 3) return new Response("capacity", { status: 503 })
          return new Response(
            entry.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
              (entry.provider === "openai-chat" ? "data: [DONE]\n\n" : ""),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const options = {
        binary,
        db: path.join(tmp.path, "native.db"),
        workspace: tmp.path,
        provider: entry.provider,
        model: "actual-wire-model",
        endpoint: new URL(entry.path, server.url).toString(),
        env: {
          OPENAI_API_KEY: "fixture-only-key",
          ANTHROPIC_API_KEY: "fixture-only-key",
          GEMINI_API_KEY: "fixture-only-key",
        },
      }
      const client = EngineClient.start(options)
      const receipts: ReturnType<typeof BlackboxTape.json>[] = []
      const results: ReturnType<typeof BlackboxTape.json>[] = []
      const requestSequences: number[] = []
      const stopped = Promise.withResolvers<void>()
      const timer = setTimeout(() => stopped.reject(new Error("native drain did not stop")), 15000)
      client.onEvent((event) => {
        if (event.kind === "provider.request") {
          receipts.push(BlackboxTape.json(event.data))
          requestSequences.push(event.seq)
        }
        if (event.kind === "provider.request.result") results.push(BlackboxTape.json(event.data))
        if (event.kind === "stop" || event.kind === "stop_failure") stopped.resolve()
      })
      try {
        await client.subscribe("session", 0)
        await client.admit({ session_id: "session", input_id: "input", prompt: "say done" })
        await stopped.promise
        expect(packets).toHaveLength(3)
        expect(receipts).toHaveLength(3)
        expect(results.map((result) => (BlackboxTape.isObject(result) ? result.http_status : null))).toEqual([
          503, 503, 200,
        ])
        expect(results.map((result) => (BlackboxTape.isObject(result) ? result.request_seq : null))).toEqual(
          requestSequences,
        )
        expect(results.every((result) => BlackboxTape.isObject(result) && result.outcome === "headers_received")).toBe(
          true,
        )
        receipts.forEach((receipt, index) => {
          if (!BlackboxTape.isObject(receipt)) throw new Error("invalid receipt")
          const packet = packets[index]
          if (packet === undefined) throw new Error("missing actual packet")
          expect(receipt.attempt).toBe(index + 1)
          expect(receipt.step).toBe(0)
          expect(receipt.phase).toBe("prepared")
          expect(receipt.request_body_sha256).toBe(new Bun.CryptoHasher("sha256").update(packet).digest("hex"))
          expect(receipt.profile).toEqual({
            coverage: "runtime-and-wire",
            ...EngineWireProfile.captureWireProfile({
              protocol: entry.provider,
              endpoint: options.endpoint,
              request: JSON.parse(packet),
              agent: receipt.agent,
              permissions: receipt.permissions,
            }),
          })
          if (!BlackboxTape.isObject(receipt.agent) || !BlackboxTape.isObject(receipt.permissions))
            throw new Error("missing runtime authority")
          expect(receipt.agent.name).toBe("native-runtime")
          expect(receipt.permissions.policy).toMatchObject({ config: { mode: "read_only", allow_process: false } })
          expect(receipt.permissions.boundary).toMatchObject({ writes: false, process: false, workspace: tmp.path })
        })
        expect(JSON.stringify(receipts)).not.toContain("fixture-only-key")
      } finally {
        clearTimeout(timer)
        await client.close()
        server.stop(true)
      }
      const reopened = EngineClient.start(options)
      try {
        const result = BlackboxTape.json(
          await reopened.request("events", { session_id: "session", after: 0, limit: 200 }),
        )
        if (!Array.isArray(result)) throw new Error("invalid replay events")
        expect(
          result
            .filter((event) => BlackboxTape.isObject(event) && event.kind === "provider.request")
            .map((event) => {
              if (!BlackboxTape.isObject(event)) throw new Error("invalid event")
              return event.data
            }),
        ).toEqual(receipts)
      } finally {
        await reopened.close()
      }
    },
    30000,
  ),
)
