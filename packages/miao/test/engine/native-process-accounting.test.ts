import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

// CFG-04 / issue #1412: boot and shutdown must account for the whole process
// tree — one engine per active storage, its LSP children, and no orphans after
// shutdown. Restarting the product against the same storage must not grow the
// tree: a boot that spawns engines for storages nobody opened is the #1412
// regression this test pins.
test.skipIf(!binary)(
  "boot and shutdown account every engine and LSP child without orphans or bloat",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    await Bun.write(path.join(directory, "notes.txt"), "fixture text\n")

    const lspServer = path.join(tmp.path, "fixture-lsp.js")
    await Bun.write(
      lspServer,
      [
        `let buffer = Buffer.alloc(0)`,
        `let replied = false`,
        `process.stdin.on("data", (chunk) => {`,
        `  buffer = Buffer.concat([buffer, chunk])`,
        `  for (;;) {`,
        `    const head = buffer.indexOf("\\r\\n\\r\\n")`,
        `    if (head === -1) return`,
        `    const header = buffer.slice(0, head).toString("utf8")`,
        `    const match = header.match(/Content-Length: (\\d+)/)`,
        `    if (!match) return`,
        `    const start = head + 4`,
        `    const end = start + Number(match[1])`,
        `    if (buffer.length < end) return`,
        `    const message = JSON.parse(buffer.slice(start, end).toString("utf8"))`,
        `    buffer = buffer.slice(end)`,
        `    if (!replied && message.method === "initialize") {`,
        `      replied = true`,
        `      const body = JSON.stringify({ id: message.id, result: { capabilities: {} } })`,
        `      process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`)`,
        `    }`,
        `  }`,
        `})`,
        ``,
      ].join("\n"),
    )

    const bodies: unknown[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        const chunk = (payload: unknown) =>
          new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        if (bodies.length % 2 === 1) {
          return chunk({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "lsp_diagnostics", arguments: JSON.stringify({ path: "notes.txt" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })
        }
        return chunk({
          choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }],
        })
      },
    })

    const env = {
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
        lsp: { fixturelsp: { command: [process.execPath, lspServer], extensions: [".txt"] } },
      }),
    }

    const start = async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: path.join(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      while (!output.match(/miao server listening on (http:\/\/[^\s]+)/)) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(45_000).then(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>),
        ])
        if (chunk.done) throw new Error(`server exited before listening: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
      }
      return { child, stderr, url: output.match(/miao server listening on (http:\/\/[^\s]+)/)![1]! }
    }

    const headers = {
      "x-opencode-directory": directory,
      "content-type": "application/json",
      authorization: "Basic " + btoa("fixture:fixture-password"),
    }
    const sessionID = "ses_process_accounting"
    const prompt = (url: string, id: string, text: string) =>
      fetch(url + `/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, prompt: { text } }),
      })
    const answers = async (url: string) => {
      const listed = await fetch(url + `/api/session/${sessionID}/message`, { headers })
      const body = (await listed.json()) as { data?: { type: string; content?: { text?: string }[] }[] }
      return (body.data ?? [])
        .filter((message) => message.type === "assistant")
        .map((message) => (message.content ?? []).map((part) => part.text ?? "").join(""))
    }
    const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await check()) return
        await Bun.sleep(250)
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    const rows = () => {
      const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString()
      return out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const trimmed = line.trimStart()
          const pid = Number(trimmed.split(/\s+/)[0])
          const rest = trimmed.slice(trimmed.indexOf(" ") + 1).trimStart()
          const ppid = Number(rest.split(/\s+/)[0])
          return { pid, ppid, command: rest.slice(rest.indexOf(" ") + 1).trimStart() }
        })
    }
    const engines = async () =>
      (await rows()).filter(
        (row) => row.command.includes(path.join(tmp.path, "engines")) && row.command.includes("--db"),
      )
    const lspServers = async () => (await rows()).filter((row) => row.command.includes("fixture-lsp.js"))
    const drained = async () => (await engines()).length === 0 && (await lspServers()).length === 0

    const turn = async (url: string, id: string) => {
      expect((await prompt(url, id, "check diagnostics")).status).toBe(200)
      // Count mid-turn: the engine is booting for exactly this storage, and the
      // LSP child exists from the tool call until the engine goes idle. Booting
      // must not enumerate engines for any other storage (#1412).
      await wait(async () => (await engines()).length === 1, "one engine for the active storage")
      expect((await engines()).length).toBe(1)
      await wait(async () => (await lspServers()).length === 1, "the engine's LSP child")
      expect((await lspServers()).length).toBe(1)
      await wait(async () => (await answers(url)).includes("answer"), "the turn answer")
    }

    const first = await start()
    try {
      const created = await fetch(first.url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionID, location: { directory } }),
      })
      expect(created.status).toBe(200)
      await turn(first.url, "msg_accounting_1")
    } finally {
      first.child.kill()
      await first.child.exited
      await Promise.race([first.stderr, Bun.sleep(5_000)])
    }

    await wait(drained, "every engine and LSP child to exit with the server")

    const second = await start()
    try {
      await turn(second.url, "msg_accounting_2")
    } finally {
      second.child.kill()
      await second.child.exited
      await Promise.race([second.stderr, Bun.sleep(5_000)])
      provider.stop(true)
    }

    await wait(drained, "every engine and LSP child to exit after the second server")
  },
  180_000,
)
