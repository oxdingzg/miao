import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { providerProxy } from "@/blackbox/provider"
import { runEnginePrompt } from "@/engine/run"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

for (const operation of ["write", "read", "read-disabled", "read-no-compat"] as const) {
  real(
    `native ${operation} receipts replay without reexecuting file tools or live provider calls`,
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "miao-native-tool-replay-"))
      const workspace = path.join(directory, "workspace")
      await Bun.write(path.join(workspace, ".fixture"), "fixture")
      const reading = operation !== "write"
      const suppressed = operation === "read-disabled" || operation === "read-no-compat"
      const relative = reading ? "src/marker.txt" : "marker.txt"
      const name = reading ? "read_file" : "write_file"
      const input = BlackboxTape.json(
        reading ? { path: relative } : { path: relative, text: "once", expected_sha256: null },
      )
      const answer = reading ? "read once" : "written once"
      if (reading) {
        await Bun.write(path.join(workspace, relative), "once")
        await Bun.write(
          path.join(workspace, operation === "read-no-compat" ? "src/CLAUDE.md" : "src/AGENTS.md"),
          "NESTED_READ_RULE: preserve the fixture.\n",
        )
      }
      const policy = path.join(directory, "policy.json")
      await Bun.write(
        policy,
        JSON.stringify({ mode: "workspace", rules: [{ tool: name, path: "**", decision: "allow" }] }),
      )
      let requests = 0
      const upstream = Bun.serve({
        port: 0,
        async fetch(request) {
          requests++
          const body = await request.json()
          const completed = body.messages.some((message: { role: string }) => message.role === "tool")
          if (reading && completed) expect(JSON.stringify(body.messages).includes("NESTED_READ_RULE")).toBe(!suppressed)
          const delta = completed
            ? { role: "assistant", content: answer }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${operation}`,
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify(input),
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
        prompt: `${operation} the marker`,
        env: {
          OPENAI_API_KEY: "fixture-only",
          ...(operation === "read-disabled" ? { MIAO_DISABLE_PROJECT_CONFIG: "TRUE" } : {}),
          ...(operation === "read-no-compat" ? { MIAO_DISABLE_CLAUDE_CODE: "TRUE" } : {}),
        },
        timeoutMs: 15_000,
      }
      try {
        const first = await runEnginePrompt({
          ...options,
          db: path.join(directory, "record.db"),
          blackbox: recorder,
          endpoint: new URL("/chat/completions", record.server.url).toString(),
        })
        expect(first.text).toBe(answer)
        expect(first.events.at(-1)?.kind).toBe("stop")
        expect(first.events.findLast((event) => event.kind === "run.finished")?.seq).toBeLessThan(
          first.events.at(-1)?.seq ?? -1,
        )
        expect(await Bun.file(path.join(workspace, relative)).text()).toBe("once")
        const bundle = await BlackboxTape.load(file)
        const calls = bundle.interactions.filter((item) => item.lane === "native-tool")
        expect(calls).toHaveLength(1)
        expect(calls[0].outcome).toBe("complete")
        expect(calls[0].request).toEqual({
          name,
          input,
        })
        await rm(path.join(workspace, relative))
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
          expect(await Bun.file(path.join(workspace, relative)).exists()).toBe(false)
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
}
