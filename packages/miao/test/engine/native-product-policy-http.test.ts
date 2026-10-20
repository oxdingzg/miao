import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

async function exercise(permissions: unknown, target: string) {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "project")
  await Bun.$`mkdir -p ${directory}`.quiet()
  let calls = 0
  let toolNames: string[] = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++
      const body = await request.json()
      toolNames = body.tools?.map((tool: { function?: { name?: string } }) => tool.function?.name) ?? []
      const first = !body.messages.some((message: { role: string }) => message.role === "tool")
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-call",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: target, text: "written by Rust", expected_sha256: null }),
                },
              },
            ],
          }
        : { content: "completed-native-product-policy-turn" }
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const sessionID = `ses_native_product_policy_${crypto.randomUUID()}`
  const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      MIAO_DB: path.join(tmp.path, "miao.db"),
      MIAO_ENGINE_BIN: binary,
      MIAO_ENGINE_PROVIDER: "openai-chat",
      MIAO_ENGINE_MODEL: "fixture",
      MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
      MIAO_ENGINE_POLICY: "",
      MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
      OPENAI_API_KEY: "fixture-only",
      MIAO_PURE: "1",
      MIAO_SERVER_PASSWORD: "fixture-password",
      MIAO_SERVER_USERNAME: "fixture",
      MIAO_TEST_HOME: path.join(tmp.path, "home"),
      MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      MIAO_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/fixture",
        ...(permissions === undefined ? {} : { permissions }),
        providers: {
          fixture: {
            name: "Fixture",
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: "http://127.0.0.1:1",
              settings: { apiKey: "fixture-only" },
            },
            models: { fixture: { name: "Fixture" } },
          },
        },
        formatter: false,
        lsp: false,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    let output = ""
    const reader = child.stdout.getReader()
    let url = ""
    while (!url) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`native HTTP server exited: ${await stderr} ${output}`)
      output += new TextDecoder().decode(chunk.value)
      url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
    }
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const create = await fetch(url + "/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: sessionID, location: { directory } }),
    })
    if (create.status !== 200)
      throw new Error(`native create failed: ${create.status} ${await create.text()} ${await stderr}`)
    const prompt = await fetch(url + "/api/session/" + sessionID + "/prompt", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: `msg_${sessionID}`, prompt: { text: "write the file" } }),
    })
    expect(prompt.status).toBe(200)
    const deadline = Date.now() + 15_000
    let history = ""
    while (Date.now() < deadline) {
      const response = await fetch(url + "/api/session/" + sessionID + "/history", { headers })
      if (!response.ok) throw new Error(`native history HTTP ${response.status}`)
      history = await response.text()
      if (history.includes("completed-native-product-policy-turn")) break
      await Bun.sleep(50)
    }
    expect(history).toContain("completed-native-product-policy-turn")
    return {
      calls,
      toolNames,
      written: await Bun.file(path.join(directory, target)).exists(),
      history,
    }
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await stderr
    provider.stop(true)
  }
}

test.skipIf(!binary)(
  "an automatically discovered engine gets the product agent authority without an explicit policy",
  async () => {
    const result = await exercise(undefined, "native-default.txt")
    expect(result.toolNames).toContain("plugin_tools")
    expect(result.toolNames).toContain("plugin_tool")
    expect(result.written).toBe(true)
    expect(result.calls).toBe(2)
    expect(result.history).toContain("native-default.txt")
  },
  40_000,
)

test.skipIf(!binary)(
  "a product edit denial still wins over the generated capability policy",
  async () => {
    const result = await exercise([{ action: "edit", resource: "blocked.txt", effect: "deny" }], "blocked.txt")
    expect(result.written).toBe(false)
    expect(result.calls).toBe(2)
  },
  40_000,
)
