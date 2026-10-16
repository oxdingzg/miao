import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// G1 (R4.4) product-level acceptance: one placement authority per Session.
// The catalog row binds once, an exact retry adopts it (no second execution),
// a conflicting reuse is refused without state change, and racing creates
// leave exactly one durable authority.
if (!binary) test.skip("G1: native placement stays singular through the product API", () => {})
if (binary)
  test("G1: native placement stays singular through the product API", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const bodies: unknown[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json())
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `placement answer ${bodies.length}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary!,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
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
    const timer = setTimeout(() => child.kill(), 60_000)
    const productDb = () => {
      const db = new Database(path.join(tmp.path, "miao.db"), { readonly: true })
      try {
        return db
          .query("SELECT engine, native_storage, location FROM session_engine_placement WHERE session_id = ?")
          .get("ses_g1_placement") as { engine: string; native_storage: string; location: string } | null
      } finally {
        db.close()
      }
    }
    try {
      let output = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      let url = ""
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native HTTP server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }

      // Racing creates with one identity leave exactly one durable authority.
      const creates = await Promise.all([
        fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify({ id: "ses_g1_placement", location: { directory } }) }),
        fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify({ id: "ses_g1_placement", location: { directory } }) }),
      ])
      expect(creates.map((response) => response.status)).toEqual([200, 200])

      const prompt = await fetch(url + "/api/session/ses_g1_placement/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_g1", prompt: { text: "settle placement" } }),
      })
      expect(prompt.status).toBe(200)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && bodies.length === 0) await Bun.sleep(50)
      expect(bodies).toHaveLength(1)

      // Creating the native Session binds one rust placement with its own
      // storage; the racing loser adopted the same authority.
      const binding = productDb()
      expect(binding).not.toBeNull()
      expect(binding!.engine).toBe("rust")
      expect(JSON.parse(binding!.location)).toMatchObject({ directory })
      expect(binding!.native_storage).toContain(path.join(tmp.path, "engines"))

      // An exact retry adopts the binding: acknowledged, but nothing re-runs.
      const retry = await fetch(url + "/api/session/ses_g1_placement/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_g1", prompt: { text: "settle placement" } }),
      })
      expect(retry.status).toBe(200)
      const settleDeadline = Date.now() + 5_000
      while (Date.now() < settleDeadline && bodies.length > 1) await Bun.sleep(50)
      expect(bodies).toHaveLength(1)
      expect(productDb()).toEqual(binding)

      // A conflicting reuse is refused and leaves no trace.
      const conflict = await fetch(url + "/api/session/ses_g1_placement/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_g1", prompt: { text: "a different prompt entirely" } }),
      })
      expect(conflict.status).toBeGreaterThanOrEqual(400)
      expect(bodies).toHaveLength(1)
      expect(productDb()).toEqual(binding)

      const engineDb = new Database(binding!.native_storage!, { readonly: true })
      try {
        const billed = engineDb
          .query("SELECT count(*) AS count FROM engine_event WHERE kind='usage'")
          .get() as { count: number }
        expect(billed.count).toBe(1)
      } finally {
        engineDb.close()
      }
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  }, 90_000)
