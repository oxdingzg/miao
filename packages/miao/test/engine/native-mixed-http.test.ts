import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("composing a native transport preserves TS prompt admission without native placement", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "project")
  await Bun.$`mkdir -p ${directory}`.quiet()
  // This executable must never start: no native placement was requested.
  const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      MIAO_DB: path.join(tmp.path, "miao.db"),
      MIAO_ENGINE_BIN: path.join(tmp.path, "must-not-start"),
      MIAO_ENGINE_STORAGE: "",
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
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    let output = ""
    let url = ""
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    while (!url) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`server exited: ${await stderr} ${output}`)
      output += decoder.decode(chunk.value)
      url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
    }
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const created = await fetch(url + "/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ location: { directory } }),
      signal: AbortSignal.timeout(10_000),
    })
    expect(created.status).toBe(200)
    const session = await created.json()
    expect(session.data.execution).toBeUndefined()
    const response = await fetch(url + `/api/session/${session.data.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: { text: "Durable TS admission with native transport available" }, resume: false }),
      signal: AbortSignal.timeout(10_000),
    })
    expect(await response.clone().text()).not.toContain("missing its native placement")
    expect(response.status).toBe(200)
    expect((await response.json()).data.sessionID).toBe(session.data.id)
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await stderr
  }
}, 40_000)
