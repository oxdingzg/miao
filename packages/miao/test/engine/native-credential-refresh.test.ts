import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// 3e: the product owns credential refresh (ADR-09); the engine re-reads its
// credential database row at every provider turn. A refresh written by the
// product must reach the engine without restarting it — the next turn
// authenticates with the rotated token.
if (!binary) test.skip("credential refresh reaches the engine without a restart", () => {})
if (binary)
  test("credential refresh reaches the engine without a restart", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()

    // The product's credential store (final migration schema) with the first
    // generation of the fixture credential.
    const credentialDb = path.join(tmp.path, "credentials.db")
    const writeCredential = (token: string) => {
      const db = new Database(credentialDb)
      try {
        db.run(
          `INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
           VALUES ('cred_fixture', 'openai', 'Fixture', ?, true, 1, 1)
           ON CONFLICT(id) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated`,
          [JSON.stringify({ type: "key", key: token })],
        )
      } finally {
        db.close()
      }
    }
    {
      const db = new Database(credentialDb)
      db.run(`CREATE TABLE credential (
        id text PRIMARY KEY,
        integration_id text,
        label text NOT NULL,
        value text NOT NULL,
        connector_id text,
        method_id text,
        active integer,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      )`)
      db.close()
    }
    writeCredential("fixture-token-v1")

    // The fixture provider records the bearer credential every engine turn.
    const seen: (string | null)[] = []
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        await request.json()
        seen.push(request.headers.get("authorization"))
        const chunk = {
          id: "fixture",
          choices: [{ index: 0, delta: { content: `turn ${seen.length} done` }, finish_reason: "stop" }],
        }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary!,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_ENGINE_CREDENTIAL_DB: credentialDb,
        MIAO_ENGINE_CREDENTIAL_ID: "cred_fixture",
        MIAO_ENGINE_CREDENTIAL_INTEGRATION: "openai",
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
              api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://127.0.0.1:1", settings: { apiKey: "fixture-only" } },
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
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify({ id: "ses_g1_cred", location: { directory } }) })
      expect(create.status).toBe(200)

      const runTurn = async (marker: string, messageId: string, text: string) => {
        const prompt = await fetch(url + "/api/session/ses_g1_cred/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: messageId, prompt: { text } }),
        })
        expect(prompt.status).toBe(200)
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const history = await (await fetch(url + "/api/session/ses_g1_cred/history", { headers })).text()
          if (history.includes(marker)) return
          await Bun.sleep(100)
        }
      }

      await runTurn("turn 1 done", "msg_cred_1", "first turn")
      expect(seen.at(-1)).toBe("Bearer fixture-token-v1")

      // The product writer rotates the stored credential.
      writeCredential("fixture-token-v2")

      await runTurn("turn 2 done", "msg_cred_2", "second turn after refresh")
      // The engine re-read the row this turn: the rotated token authenticated.
      expect(seen.at(-1)).toBe("Bearer fixture-token-v2")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  }, 90_000)
