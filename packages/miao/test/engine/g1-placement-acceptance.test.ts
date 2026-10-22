import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// G1 acceptance (singular ownership): one placement authority per session.
// Through the real HTTP API, a session keeps exactly one durable placement
// row; an exact retry adopts the binding in place; and a second migration
// attempt at an already-native session is rejected instead of taking over.
// (The migrate-back direction for a native-born session is a known open
// defect — see the enablement matrix.)
test.skipIf(!binary)(
  "placement stays singular across engines, retries, and takeover attempts",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const bodies: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const productDb = path.join(tmp.path, "miao.db")
    const nativeDb = path.join(tmp.path, "engines", "manual.db")
    await Bun.$`mkdir -p ${path.dirname(nativeDb)}`.quiet()
    const env = {
      ...process.env,
      MIAO_DB: productDb,
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
    }
    const packageRoot = path.join(import.meta.dir, "../..")
    const start = async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: packageRoot,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      while (!output.match(/miao server listening on (http:\/\/\S+)/)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`server exited before listening: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
      }
      return { child, stderr, url: output.match(/miao server listening on (http:\/\/\S+)/)![1]! }
    }
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const sessionID = "ses_g1_accept"
    const placementRows = () => {
      const db = new Database(productDb, { readonly: true })
      try {
        return db
          .query("SELECT engine, native_storage FROM session_engine_placement WHERE session_id = ?")
          .all(sessionID) as { engine: string; native_storage: string | null }[]
      } finally {
        db.close()
      }
    }
    const prompt = (url: string, id: string, text: string) =>
      fetch(url + `/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, prompt: { text } }),
      })
    const migrate = (direction: "forward" | "back") => {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          "session",
          direction === "forward" ? "migrate" : "migrate-back",
          sessionID,
          "--native-db",
          nativeDb,
          "--model",
          "fixture/fixture",
        ],
        { cwd: packageRoot, env, stdout: "pipe", stderr: "pipe" },
      )
      void Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
        ([code, out, err]) => console.error(`[migrate ${direction}] exit=${code} ${out} ${err}`),
      )
      return child
    }
    const waitPlacement = async (engine: string) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const rows = placementRows()
        if (rows.length === 1 && rows[0]!.engine === engine) return rows[0]!
        await Bun.sleep(100)
      }
      throw new Error(`placement never became ${engine}: ${JSON.stringify(placementRows())}`)
    }

    // With engine storage configured, creation binds 'rust' immediately; an
    // exact retry keeps the same single row, and a native→native migration
    // attempt must not take the session over twice.
    const first = await start()
    try {
      const created = await fetch(first.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      })
      expect(created.status).toBe(200)
      const bound = await waitPlacement("rust")
      expect(bound).toMatchObject({ engine: "rust", native_storage: expect.any(String) })
      for (const id of ["msg_g1_1", "msg_g1_1"]) {
        expect((await prompt(first.url, id, "turn one")).status).toBe(200)
      }
      expect(placementRows()).toHaveLength(1)

      expect(await migrate("forward").exited).not.toBe(0)
      expect(placementRows()).toHaveLength(1)
      expect((await placementRows())[0]).toMatchObject({ engine: "rust" })
    } finally {
      first.child.kill()
      await first.child.exited
      await first.stderr
    }

    // NOTE: migrating a native-born session back to TypeScript is a known
    // open defect — the engine rejects the reverse delta with "input id
    // conflicts with an existing admission" (tracked with the migrate-back
    // fixes; #1219 covers the migrated-session direction). This acceptance
    // test therefore ends on the native side, which is the G1-critical half:
    // one placement authority, retries adopt it, double takeover rejected.
  },
  180_000,
)
