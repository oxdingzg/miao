import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real(
  "blackbox CLI records a real engine, replays offline, and exits nonzero with the first difference",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "miao-blackbox-cli-"))
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"CLI OK"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const run = async (command: string, db: string, extra: string[] = []) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/blackbox/cli.ts",
          command,
          "--bundle",
          path.join(dir, "record.json"),
          "--binary",
          binary!,
          "--workspace",
          dir,
          "--db",
          path.join(dir, db),
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENAI_API_KEY: "fixture-only" } },
      )
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exit, stdout, stderr }
    }
    try {
      const capture = await run("record-engine", "capture.db", [
        "--upstream",
        upstream.url.toString(),
        "--model",
        "test-model",
        "--prompt",
        "hello",
      ])
      expect(capture.stderr).toBe("")
      expect(capture.exit).toBe(0)
      expect(JSON.parse(capture.stdout).text).toBe("CLI OK")
      await upstream.stop(true)
      const replay = await run("replay-engine", "replay.db")
      expect(replay.stderr).toBe("")
      expect(replay.exit).toBe(0)
      expect(JSON.parse(replay.stdout).text).toBe("CLI OK")
      const mismatch = await run("replay-engine", "different.db", ["--prompt", "changed"])
      expect(mismatch.exit).toBe(1)
      const report = JSON.parse(mismatch.stderr)
      expect(report.type).toBe("blackbox.failed")
      // HTTP and event delivery are separate causal lanes; either can expose
      // the changed prompt first, and neither may return a successful replay.
      expect(["$.data.prompt", "$.body.messages[1].content"]).toContain(report.difference.path)
      expect(report.difference.expected).toBe("hello")
      expect(report.difference.actual).toBe("changed")
    } finally {
      await upstream.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)
