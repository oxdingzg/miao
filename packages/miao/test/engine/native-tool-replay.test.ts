import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { providerProxy } from "@/blackbox/provider"
import { runEnginePrompt } from "@/engine/run"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "native write receipts replay without file writes or live provider calls",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-native-tool-replay-"))
    const workspace = path.join(directory, "workspace")
    await Bun.write(path.join(workspace, ".fixture"), "fixture")
    const policy = path.join(directory, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", rules: [{ tool: "write_file", path: "**", decision: "allow" }] }),
    )
    let requests = 0
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        requests++
        const body = await request.json()
        const completed = body.messages.some((message: { role: string }) => message.role === "tool")
        const delta = completed
          ? { role: "assistant", content: "written once" }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "marker.txt", text: "once", expected_sha256: null }),
                  },
                },
              ],
            }
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const file = path.join(directory, "bundle.json")
    const recorder = new BlackboxTape.Recorder(file, { engine: "rust" })
    const record = await providerProxy({ recorder, upstream: upstream.url.toString() })
    const options = {
      binary: binary!,
      workspace,
      policyFile: policy,
      model: "test-model",
      provider: "openai-chat",
      prompt: "write the marker",
      env: { OPENAI_API_KEY: "fixture-only" },
      timeoutMs: 15_000,
    }
    try {
      const first = await runEnginePrompt({
        ...options,
        db: path.join(directory, "record.db"),
        blackbox: recorder,
        endpoint: new URL("/chat/completions", record.server.url).toString(),
      })
      expect(first.text).toBe("written once")
      expect(await Bun.file(path.join(workspace, "marker.txt")).text()).toBe("once")
      const bundle = await BlackboxTape.load(file)
      const calls = bundle.interactions.filter((item) => item.lane === "native-tool")
      expect(calls).toHaveLength(1)
      expect(calls[0].outcome).toBe("complete")
      expect(calls[0].request).toEqual({
        name: "write_file",
        input: { path: "marker.txt", text: "once", expected_sha256: null },
      })
      await rm(path.join(workspace, "marker.txt"))
      await upstream.stop(true)
      const replay = new BlackboxTape.Replay(bundle)
      const offline = await providerProxy({ replay })
      try {
        const second = await runEnginePrompt({
          ...options,
          db: path.join(directory, "replay.db"),
          toolReplayFile: file,
          blackbox: replay,
          endpoint: new URL("/chat/completions", offline.server.url).toString(),
        })
        expect(second.text).toBe(first.text)
        expect(requests).toBe(2)
        expect(await Bun.file(path.join(workspace, "marker.txt")).exists()).toBe(false)
        expect(offline.failures).toHaveLength(0)
        replay.assertConsumed()
      } finally {
        await offline.server.stop(true)
      }
    } finally {
      await record.server.stop(true)
      await upstream.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
