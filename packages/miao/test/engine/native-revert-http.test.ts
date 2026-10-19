import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native revert phases are served by the engine", () => {})

if (binary)
  test("native revert phases are served by the engine", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(policy, JSON.stringify({ mode: "workspace" }))
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_POLICY: policy,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:9/unused",
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "A_TOKEN",
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
      const create = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "ses_native_revert", location: { directory } }),
      })
      expect(create.status).toBe(200)
      const session = url + "/api/session/ses_native_revert"
      const stage = await fetch(session + "/revert/stage", {
        method: "POST",
        headers,
        body: JSON.stringify({ messageID: "msg_missing" }),
      })
      expect(stage.status).toBe(409)
      expect(await stage.text()).toContain("No committed message")
      for (const phase of ["clear", "commit"]) {
        const response = await fetch(session + "/revert/" + phase, { method: "POST", headers, body: "{}" })
        expect(response.status).toBe(409)
        expect(await response.text()).toContain("no staged revert")
      }
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  })
