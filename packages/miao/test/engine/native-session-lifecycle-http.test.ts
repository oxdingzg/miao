import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native Session archive and remove are served by the engine over HTTP", () => {})
if (binary)
  test("native Session archive and remove are served by the engine over HTTP", async () => {
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
      const body = { id: "ses_native_lifecycle", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const sessionPath = url + "/api/session/" + body.id
      const archivePath = sessionPath + "/archive"
      expect((await fetch(archivePath, { method: "POST" })).status).toBe(401)
      const archived = await fetch(archivePath, {
        method: "POST",
        headers,
        body: JSON.stringify({ archived: true }),
      })
      expect(archived.status).toBe(204)
      const archivedGet = await fetch(sessionPath, { headers })
      expect((await archivedGet.json()).data.time.archived).toBeDefined()
      const restored = await fetch(archivePath, {
        method: "POST",
        headers,
        body: JSON.stringify({ archived: false }),
      })
      expect(restored.status).toBe(204)
      expect((await (await fetch(sessionPath, { headers })).json()).data.time.archived).toBeUndefined()
      // A fork survives its parent's removal: only the lineage edge is dropped.
      const fork = await fetch(sessionPath + "/fork", { method: "POST", headers, body: "{}" })
      expect(fork.status).toBe(200)
      const forked = await fork.json()
      expect(forked.data.parentID).toBe(body.id)
      const removePath = sessionPath + "/remove"
      expect((await fetch(removePath, { method: "POST" })).status).toBe(401)
      const removed = await fetch(removePath, { method: "POST", headers })
      expect(removed.status).toBe(204)
      // The placement is released with the rows, so the identity routes as
      // unknown instead of pointing at a storage that no longer has it.
      expect((await fetch(sessionPath, { headers })).status).toBe(404)
      const list = await fetch(url + "/api/session?directory=" + encodeURIComponent(directory), { headers })
      expect(list.status).toBe(200)
      expect((await list.json()).data.map((session: { id: string }) => session.id)).toEqual([forked.data.id])
      const childGet = await fetch(url + "/api/session/" + forked.data.id, { headers })
      expect(childGet.status).toBe(200)
      expect((await childGet.json()).data.parentID).toBeUndefined()
      // The removed identity can be created again, with a fresh conversation.
      const recreated = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(recreated.status).toBe(200)
      expect((await recreated.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
    }
  }, 70_000)
