import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Reply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})
const Approval = Schema.Struct({ request_id: Schema.String, input_hash: Schema.String, policy_revision: Schema.String })
const Snapshot = Schema.Struct({
  agent: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  approvals: Schema.Array(Approval),
  active_run: Schema.NullOr(Schema.String),
})

test.skipIf(!binary).each([
  ["ask", false],
  ["deny", false],
  ["ask", true],
  ["deny", true],
] as const)(
  "the actual TUI shim binds default agent %s rules before native dispatch (shared: %s)",
  async (decision, shared) => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    const file = path.join(workspace, "guarded.txt")
    const calls: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push(await request.json())
        const tools = calls.length === 1
        const delta = tools
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "guarded.txt", text: "approved", expected_sha256: null }),
                  },
                },
              ],
            }
          : { content: "finished" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "src/index.ts",
        "__engine-shim",
        "serve",
        "--db",
        path.join(tmp.path, "source.db"),
        "--workspace",
        workspace,
        "--model",
        "fixture/fixture",
      ],
      {
        cwd: path.join(import.meta.dir, "../.."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          MIAO_ENGINE_BIN: binary,
        MIAO_SHARED_PERMISSIONS: shared ? "1" : "",
          MIAO_ENGINE_REAL_BIN: binary,
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).href,
          OPENAI_API_KEY: "fixture-only",
          MIAO_DB: path.join(tmp.path, "core.db"),
          MIAO_PURE: "1",
          MIAO_TEST_HOME: path.join(tmp.path, "home"),
          MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          MIAO_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            permission: { "*": decision },
            formatter: false,
            lsp: false,
            providers: {
              fixture: {
                name: "Fixture",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: provider.url.href,
                  settings: { apiKey: "fixture-only" },
                },
                models: { fixture: { name: "Fixture" } },
              },
            },
          }),
        },
      },
    )
    const stderr = new Response(child.stderr).text()
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    let next = 0
    const request = async (method: string, params?: unknown): Promise<unknown> => {
      const id = ++next
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
      await child.stdin.flush()
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end !== -1) {
          const frame = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          const decoded = Schema.decodeUnknownSync(Reply)(frame)
          if (decoded.id !== id) continue
          if (decoded.error) throw new Error(JSON.stringify(decoded.error))
          return decoded.result
        }
        const item = await reader.read()
        if (item.done) throw new Error("TUI shim ended before reply: " + (await stderr))
        buffer += item.value
      }
    }
    const deadline = setTimeout(() => child.kill(), 30_000)
    try {
      await request("initialize", { session_id: "s", title: "guarded" })
      await request("admit", {
        input: { session_id: "s", input_id: "one", prompt: "write guarded.txt", delivery: "steer" },
        resume: true,
      })
      const end = Date.now() + 15_000
      let snapshot = Schema.decodeUnknownSync(Snapshot)(await request("snapshot", { session_id: "s" }))
      while (
        Date.now() < end &&
        (decision === "ask" ? !snapshot.approvals.length : snapshot.active_run !== null || calls.length < 2)
      ) {
        await Bun.sleep(5)
        snapshot = Schema.decodeUnknownSync(Snapshot)(await request("snapshot", { session_id: "s" }))
      }
      expect(snapshot.agent?.name).toBe("build")
      expect(await Bun.file(file).exists()).toBe(false)
      if (decision === "ask") {
        expect(snapshot.approvals).toHaveLength(1)
        expect(calls).toHaveLength(1)
        await request("approve", { session_id: "s", response: { ...snapshot.approvals[0]!, decision: "allow" } })
        const end = Date.now() + 10_000
        while (Date.now() < end && !(await Bun.file(file).exists())) {
          await Bun.sleep(5)
          await request("snapshot", { session_id: "s" })
        }
        expect(await Bun.file(file).text()).toBe("approved")
      }
      if (decision === "deny") {
        expect(snapshot.active_run).toBeNull()
        expect(snapshot.approvals).toEqual([])
        expect(calls).toHaveLength(2)
      }
      await request("shutdown")
      expect(await child.exited).toBe(0)
    } finally {
      clearTimeout(deadline)
      child.kill()
      await child.exited
      await provider.stop(true)
    }
  },
  45_000,
)
