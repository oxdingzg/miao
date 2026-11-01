import { expect, test } from "bun:test"
import path from "node:path"
import { engineFake } from "../fixture/engine-binary"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_native_tag"
const directory = "/tmp"

async function serve(environment: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(import.meta.dir, "../.."),
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (!/miao server listening on (http:\/\/[^\s]+)/.test(output)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`serve exited: ${await stderr} ${output}`)
    output += decoder.decode(chunk.value)
  }
  const url = output.match(/miao server listening on (http:\/\/[^\s]+)/)![1]!
  return { child, url, stderr }
}

function headers() {
  return {
    "x-opencode-directory": directory,
    "content-type": "application/json",
    authorization: "Basic " + btoa("fixture:fixture-password"),
  }
}

test("a native Session carries the operator's tag to the engine", async () => {
  await using tmp = await tmpdir()
  const { child, url } = await serve({
    MIAO_DB: path.join(tmp.path, "miao.db"),
    MIAO_ENGINE_BIN: engineFake,
    MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
    MIAO_ENGINE_PROVIDER: "openai-chat",
    MIAO_ENGINE_MODEL: "fixture",
    MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:1/v1/chat/completions",
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
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const create = await fetch(url + "/api/session", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ id: sessionID, location: { directory } }),
    })
    expect(create.status).toBe(200)
    expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })

    const tagged = await fetch(url + `/api/session/${sessionID}/tag`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tag: "release" }),
    })
    expect(tagged.status).toBe(204)

    const cleared = await fetch(url + `/api/session/${sessionID}/tag`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tag: "" }),
    })
    expect(cleared.status).toBe(204)
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 90_000)
