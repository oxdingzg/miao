import { expect, test } from "bun:test"
import path from "node:path"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip
const responses = [
  { type: "response.created", response: { id: "response-fixture" } },
  {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PROTOCOL OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
]
const cases = [
  {
    provider: "anthropic",
    path: "/messages",
    events: [
      {
        type: "message_start",
        message: {
          id: "message-fixture",
          type: "message",
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROTOCOL OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  },
  { provider: "openai-responses", path: "/responses", events: responses },
  { provider: "subscription-responses", path: "/responses", events: responses },
  {
    provider: "gemini",
    path: "/v1beta/models/test-model:streamGenerateContent",
    events: [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "PROTOCOL OK" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    ],
  },
]

cases.forEach((entry) =>
  real(
    `actual native CLI ${entry.provider} records its endpoint and replays without live credentials`,
    async () => {
      await using tmp = await tmpdir()
      const requests: { url: string; body: BlackboxTape.Interaction["request"] }[] = []
      const upstream = Bun.serve({
        port: 0,
        async fetch(request) {
          requests.push({ url: request.url, body: BlackboxTape.json(await request.json()) })
          return new Response(entry.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const file = path.join(tmp.path, "bundle.json")
      const run = async (command: string, database: string, extra: string[] = []) => {
        const child = Bun.spawn(
          [
            process.execPath,
            "src/blackbox/cli.ts",
            command,
            "--bundle",
            file,
            "--binary",
            binary!,
            "--workspace",
            tmp.path,
            "--db",
            path.join(tmp.path, database),
            ...extra,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              OPENAI_API_KEY: command === "record-engine" ? "fixture-only" : undefined,
              ANTHROPIC_API_KEY: command === "record-engine" ? "fixture-only" : undefined,
              GEMINI_API_KEY: command === "record-engine" ? "fixture-only" : undefined,
              OPENAI_ACCESS_TOKEN: command === "record-engine" ? "fixture-only" : undefined,
              OPENAI_ACCOUNT_ID: undefined,
            },
          },
        )
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        return { exit, stdout, stderr }
      }
      try {
        const captured = await run("record-engine", "record.db", [
          "--upstream",
          new URL("/actual-endpoint", upstream.url).toString(),
          "--provider",
          entry.provider,
          "--model",
          "test-model",
          "--prompt",
          "hello",
        ])
        expect(captured.stderr).toBe("")
        expect(captured.exit).toBe(0)
        expect(JSON.parse(captured.stdout).text).toBe("PROTOCOL OK")
        expect(requests).toHaveLength(1)
        expect(new URL(requests[0].url).pathname).toBe("/actual-endpoint")
        const bundle = await BlackboxTape.load(file)
        expect(bundle.metadata.provider).toBe(entry.provider)
        expect(bundle.interactions.filter((item) => item.lane === "provider").map((item) => item.request)).toEqual([
          { method: "POST", path: entry.path, body: requests[0].body },
        ])
        expect(await Bun.file(file).text()).not.toContain("fixture-only")
        await upstream.stop(true)
        const replayed = await run("replay-engine", "replay.db")
        expect(replayed.stderr).toBe("")
        expect(replayed.exit).toBe(0)
        expect(JSON.parse(replayed.stdout).text).toBe("PROTOCOL OK")
        expect(requests).toHaveLength(1)
      } finally {
        upstream.stop(true)
      }
    },
    30000,
  ),
)
