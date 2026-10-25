import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native ACP stdout stays JSON-RPC while background title diagnostics reach stderr",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await mkdir(workspace)
    const requests: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.json())
        return new Response(
          `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ACP fixture answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const routes = path.join(tmp.path, "routes.json")
    await Bun.write(
      routes,
      JSON.stringify([
        {
          id: "fixture/fixture",
          primary: true,
          provider: "openai-chat",
          model: "fixture",
          endpoint: new URL("v1/chat/completions", provider.url).toString(),
          credential: { type: "environment", key: "OPENAI_API_KEY" },
        },
      ]),
    )
    const child = Bun.spawn(
      [process.execPath, "src/index.ts", "acp", "--mdns", "--port", "0", "--hostname", "127.0.0.1", "--cwd", workspace],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          MIAO_DB: path.join(tmp.path, "product.db"),
          MIAO_ENGINE_BIN: binary!,
          MIAO_ENGINE_STORAGE: path.join(tmp.path, "native"),
          MIAO_ENGINE_MODEL: "fixture",
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_ENDPOINT: new URL("v1/chat/completions", provider.url).toString(),
          MIAO_ENGINE_MODEL_ROUTES_CONFIG: routes,
          MIAO_PURE: "1",
          MIAO_PRINT_LOGS: "1",
          MIAO_LOG_LEVEL: "INFO",
          MIAO_ENGINE_CREDENTIAL_DB: "",
          MIAO_ENGINE_CREDENTIAL_ID: "",
          MIAO_ENGINE_CREDENTIAL_INTEGRATION: "",
          OPENAI_API_KEY: "fixture-only",
          HOME: path.join(tmp.path, "home"),
          MIAO_TEST_HOME: path.join(tmp.path, "home"),
          MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          MIAO_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            formatter: false,
            lsp: false,
            providers: {
              fixture: {
                name: "Fixture",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: new URL("v1", provider.url).toString(),
                  settings: { apiKey: "fixture-only" },
                },
                models: {
                  fixture: { name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] } },
                },
              },
            },
          }),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = child.stdout.tee()
    const stdout = new Response(output[1]).text()
    const stderr = new Response(child.stderr).text()
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      ndJsonStream(
        new WritableStream<Uint8Array>({
          async write(chunk) {
            child.stdin.write(chunk)
            await child.stdin.flush()
          },
          close() {
            child.stdin.end()
          },
        }),
        output[0],
      ),
    )
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      await connection.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const created = await connection.newSession({ cwd: workspace, mcpServers: [] })
      expect(
        (
          await connection.prompt({
            sessionId: created.sessionId,
            prompt: [{ type: "text", text: "Say the fixture answer" }],
          })
        ).stopReason,
      ).toBe("end_turn")
      const product = new Database(path.join(tmp.path, "product.db"), { readonly: true })
      const placement = product
        .query("SELECT native_storage FROM session_engine_placement WHERE session_id = ?")
        .get(created.sessionId) as { native_storage: string }
      product.close()
      const native = new Database(placement.native_storage, { readonly: true })
      try {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const row = native.query("SELECT title FROM engine_session WHERE id = ?").get(created.sessionId) as {
            title: string
          }
          if (requests.length >= 2 && row.title === "ACP fixture answer") break
          await Bun.sleep(20)
        }
        expect(requests.length).toBeGreaterThanOrEqual(2)
        expect(native.query("SELECT title FROM engine_session WHERE id = ?").get(created.sessionId)).toMatchObject({
          title: "ACP fixture answer",
        })
      } finally {
        native.close()
      }
    } finally {
      clearTimeout(timer)
      child.stdin.end()
      const stop = setTimeout(() => child.kill(), 3_000)
      await child.exited
      clearTimeout(stop)
      provider.stop(true)
    }
    const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ jsonrpc: Schema.Literal("2.0") })))
    const packets = (await stdout)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => frame(line))
    expect(packets.length).toBeGreaterThan(0)
    const diagnostics = await stderr
    expect(diagnostics).toContain("session.resolve")
    expect(diagnostics).toContain("mDNS enabled but hostname is loopback")
  },
  45_000,
)
