import { expect, test } from "bun:test"
import path from "node:path"
import { runEnginePrompt } from "@/engine/run"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "reused Sessions return only the admitted input's committed output, including historical retries",
  async () => {
    await using tmp = await tmpdir()
    let requests = 0
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        requests++
        const content = requests === 1 ? "FIRST" : "SECOND"
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
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
      session: "ses_output_scope",
      timeoutMs: 15000,
    }
    try {
      expect((await runEnginePrompt({ ...options, inputId: "in_first", prompt: "first" })).text).toBe("FIRST")
      expect((await runEnginePrompt({ ...options, inputId: "in_second", prompt: "second" })).text).toBe("SECOND")
      expect((await runEnginePrompt({ ...options, inputId: "in_first", prompt: "first" })).text).toBe("FIRST")
      expect((await runEnginePrompt({ ...options, inputId: "in_second", prompt: "second" })).text).toBe("SECOND")
      expect(requests).toBe(2)
    } finally {
      upstream.stop(true)
    }
  },
  30000,
)
