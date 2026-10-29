import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native cancellation aborts only its live host call and close aborts the remaining call",
  async () => {
    await using tmp = await tmpdir()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "host-call", type: "function", function: { name: "host_probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const policyFile = path.join(tmp.path, "policy.json")
    const productToolsFile = path.join(tmp.path, "tools.json")
    await Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] }))
    await Bun.write(
      productToolsFile,
      JSON.stringify({
        tools: [
          {
            name: "host_probe",
            description: "Cancellation signal fixture",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    )
    const first = Promise.withResolvers<AbortSignal | undefined>()
    const peer = Promise.withResolvers<AbortSignal | undefined>()
    const release = Promise.withResolvers<void>()
    const settled: string[] = []
    const cancelled: string[] = []
    const client = EngineClient.start({
      binary: binary!,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
      policyFile,
      productToolsFile,
      async onProductTool(call) {
        expect(call.messageSeq).toBeGreaterThan(0)
        if (call.sessionID === "first") first.resolve(call.signal)
        if (call.sessionID === "peer") peer.resolve(call.signal)
        await release.promise
        settled.push(call.sessionID)
        return "late host result"
      },
      onProductToolCancel(call) {
        cancelled.push(call.sessionID)
      },
    })
    try {
      await client.admit({ session_id: "first", input_id: "first-input", prompt: "call host", delivery: "steer" })
      await client.admit({ session_id: "peer", input_id: "peer-input", prompt: "call host", delivery: "steer" })
      const signals = await Promise.race([
        Promise.all([first.promise, peer.promise]),
        Bun.sleep(10_000).then(() => {
          throw new Error("live host callbacks did not arrive")
        }),
      ])
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      expect(signals[1]).toBeInstanceOf(AbortSignal)
      const aborted = Promise.withResolvers<void>()
      signals[0]!.addEventListener("abort", () => aborted.resolve(), { once: true })
      await client.cancel("first")
      await Promise.race([
        aborted.promise,
        Bun.sleep(5_000).then(() => {
          throw new Error("source cancellation did not reach its host signal")
        }),
      ])
      expect(signals[0]!.aborted).toBe(true)
      expect(signals[1]!.aborted).toBe(false)
      expect(cancelled).toEqual(["first"])
      expect(client.available).toBe(true)
      await client.close()
      expect(signals[1]!.aborted).toBe(true)
      release.resolve()
      await Bun.sleep(0)
      expect(settled.toSorted()).toEqual(["first", "peer"])
      expect(client.available).toBe(false)
    } finally {
      release.resolve()
      await client.close()
      provider.stop(true)
    }
  },
  30_000,
)
