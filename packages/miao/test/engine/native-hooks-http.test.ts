import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

async function waitForLog(log: string, marker: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await Bun.file(log).exists()) && (await Bun.file(log).text()).includes(marker)) return
    await Bun.sleep(50)
  }
  throw new Error(`hook log never contained ${marker}`)
}

function serverEnv(
  tmpPath: string,
  endpoint: string,
  config: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return {
    ...process.env,
    MIAO_DB: path.join(tmpPath, "miao.db"),
    MIAO_ENGINE_BIN: binary,
    MIAO_ENGINE_PROVIDER: "openai-chat",
    MIAO_ENGINE_MODEL: "fixture",
    MIAO_ENGINE_ENDPOINT: endpoint,
    MIAO_ENGINE_STORAGE: path.join(tmpPath, "engines"),
    OPENAI_API_KEY: "fixture-only",
    MIAO_PURE: "1",
    MIAO_SERVER_PASSWORD: "fixture-password",
    MIAO_SERVER_USERNAME: "fixture",
    MIAO_TEST_HOME: path.join(tmpPath, "home"),
    MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmpPath, "managed"),
    XDG_CONFIG_HOME: path.join(tmpPath, "config"),
    XDG_DATA_HOME: path.join(tmpPath, "data"),
    XDG_STATE_HOME: path.join(tmpPath, "state"),
    XDG_CACHE_HOME: path.join(tmpPath, "cache"),
    MIAO_CONFIG_CONTENT: JSON.stringify(config),
    ...extra,
  }
}

async function startServer(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: path.join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 45_000)
  let url = ""
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  while (!url) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`hooks HTTP server exited: ${await stderr}`)
    url += decoder.decode(chunk.value)
    url = url.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
  }
  return { child, url, stderr, timer }
}

const fixtureProvider = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await Bun.readableStreamToText(request.body!)
      const calls = Number(request.headers.get("x-fixture-calls") ?? 0)
      const delta =
        calls === 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read-1",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) },
                },
              ],
            }
          : { role: "assistant", content: "hooks-acceptance-complete" }
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: calls === 0 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

const productConfig = {
  formatter: false,
  lsp: false,
  hooks: {
    entries: [
      { event: "pre_tool_use", tool: "read_file", command: ["/bin/sh", "-c", "echo pre_tool_use >> hook-log.txt"] },
      { event: "post_tool_use", tool: "read_file", command: ["/bin/sh", "-c", "echo post_tool_use >> hook-log.txt"] },
    ],
  },
}

test.skipIf(!binary)("product configuration hooks fire around native tool execution", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "project")
  await Bun.$`mkdir -p ${directory}`.quiet()
  await Bun.write(path.join(directory, "fixture.txt"), "HOOKS_FIXTURE_BODY\n")
  const provider = fixtureProvider()
  const server = await startServer(
    serverEnv(tmp.path, new URL("v1/chat/completions", provider.url).toString(), productConfig),
  )
  try {
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const create = await fetch(server.url + "/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "ses_native_hooks", location: { directory } }),
    })
    expect(create.status).toBe(200)
    const prompt = await fetch(server.url + "/api/session/ses_native_hooks/prompt", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "msg_hooks_first", prompt: { text: "read the fixture" } }),
    })
    expect(prompt.status).toBe(200)
    const log = path.join(directory, "hook-log.txt")
    await waitForLog(log, "pre_tool_use")
    await waitForLog(log, "post_tool_use")
    expect((await Bun.file(log).text()).trim()).toBe("pre_tool_use\npost_tool_use")
    const idleDeadline = Date.now() + 15_000
    let idle = false
    while (Date.now() < idleDeadline) {
      const status = await (await fetch(server.url + "/api/session/ses_native_hooks/status", { headers })).json()
      if (status.data.type === "idle") {
        idle = true
        break
      }
      await Bun.sleep(50)
    }
    expect(idle).toBe(true)
  } finally {
    clearTimeout(server.timer)
    server.child.kill()
    await server.child.exited
    await server.stderr
    provider.stop(true)
  }
}, 30_000)

test.skipIf(!binary)("an explicit hooks manifest takes precedence over product configuration", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "project")
  await Bun.$`mkdir -p ${directory}`.quiet()
  await Bun.write(path.join(directory, "fixture.txt"), "HOOKS_FIXTURE_BODY\n")
  const manifest = path.join(tmp.path, "hooks.json")
  await Bun.write(
    manifest,
    JSON.stringify([
      { event: "post_tool_use", tool: "read_file", argv: ["/bin/sh", "-c", "echo explicit >> hook-log.txt"] },
    ]),
  )
  const provider = fixtureProvider()
  const server = await startServer(
    serverEnv(tmp.path, new URL("v1/chat/completions", provider.url).toString(), productConfig, {
      MIAO_ENGINE_HOOKS_CONFIG: manifest,
    }),
  )
  try {
    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const create = await fetch(server.url + "/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "ses_native_hooks_explicit", location: { directory } }),
    })
    expect(create.status).toBe(200)
    const prompt = await fetch(server.url + "/api/session/ses_native_hooks_explicit/prompt", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "msg_hooks_second", prompt: { text: "read the fixture" } }),
    })
    expect(prompt.status).toBe(200)
    const log = path.join(directory, "hook-log.txt")
    await waitForLog(log, "explicit")
    expect((await Bun.file(log).text()).trim()).toBe("explicit")
  } finally {
    clearTimeout(server.timer)
    server.child.kill()
    await server.child.exited
    await server.stderr
    provider.stop(true)
  }
})
