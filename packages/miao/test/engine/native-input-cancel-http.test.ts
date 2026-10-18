import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native pending input cancel is served by the engine over HTTP", () => {})
if (binary)
  test("native pending input cancel is served by the engine over HTTP", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        // Admission-only: no run is started, so this endpoint must never be
        // reached. A prompt that ran would prove the cancel did not hold.
        MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:1/v1/chat/completions",
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
        MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      let output = ""
      let url = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
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
      const body = { id: "ses_native_input_cancel", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const promptPath = url + "/api/session/" + body.id + "/prompt"
      const admit = await fetch(promptPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_queued", prompt: { text: "drop this" }, resume: false }),
      })
      expect(admit.status).toBe(200)
      const queued = await admit.json()
      expect(queued.data.id).toBe("msg_native_queued")
      const cancelPath = url + "/api/session/" + body.id + "/input/msg_native_queued"
      expect((await fetch(cancelPath, { method: "DELETE" })).status).toBe(401)
      const cancelled = await fetch(cancelPath, { method: "DELETE", headers })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toEqual({ cancelled: true })
      // The cancelled admission is durable evidence, so repeating the cancel
      // reports the same state instead of resurrecting the prompt.
      const repeated = await fetch(cancelPath, { method: "DELETE", headers })
      expect(repeated.status).toBe(200)
      expect(await repeated.json()).toEqual({ cancelled: true })
      const unknown = await fetch(url + "/api/session/" + body.id + "/input/msg_never_admitted", {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      expect(unknown.status).toBe(200)
      expect(await unknown.json()).toEqual({ cancelled: false })
      // A cancelled identity is terminal: re-admitting it conflicts rather
      // than resurrecting the prompt or reporting a receipt that never runs.
      const retry = await fetch(promptPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_queued", prompt: { text: "drop this" }, resume: false }),
      })
      expect(retry.status).toBe(409)
      // The Session is not wedged: a fresh identity still admits normally.
      const fresh = await fetch(promptPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_native_fresh", prompt: { text: "keep this" }, resume: false }),
      })
      expect(fresh.status).toBe(200)
      expect((await fresh.json()).data.id).toBe("msg_native_fresh")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
    }
  }, 70_000)
