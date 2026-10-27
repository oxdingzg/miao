import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "a Session is titled from its first answer, not only once the run goes idle",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    // One distinct file per turn: the engine refuses an identical tool call
    // after five repetitions, and this run must stay up until it is told to end.
    await Promise.all(
      Array.from({ length: 8 }, (_, turn) => Bun.write(path.join(directory, `file-${turn}`), `fixture ${turn}`)),
    )
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({ mode: "workspace", rules: [{ tool: "read_file", path: "**", decision: "allow" }] }),
    )
    const state = { finish: false, turns: 0 }
    const reply = (delta: unknown, finish: "stop" | "tool_calls" = "stop") =>
      new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        const serialized = JSON.stringify(body)
        if (serialized.includes("Generate a title for this conversation"))
          return reply({ role: "assistant", content: "Mid-run title" })
        // Each step is slow so the run is still in flight once the title
        // lands: a title generated only at idle cannot pass this test.
        await Bun.sleep(250)
        if (state.finish) return reply({ role: "assistant", content: "all steps finished" })
        const turn = state.turns++
        return reply(
          {
            role: "assistant",
            content: `step ${turn}`,
            tool_calls: [
              {
                index: 0,
                id: `read-${turn}`,
                type: "function",
                function: { name: "read_file", arguments: JSON.stringify({ path: `file-${turn % 8}` }) },
              },
            ],
          },
          "tool_calls",
        )
      },
    })
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: new URL("chat/completions", provider.url).toString(),
        MIAO_ENGINE_POLICY: policy,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_ENGINE_CREDENTIAL_DB: "",
        MIAO_ENGINE_CREDENTIAL_ID: "",
        MIAO_ENGINE_MODEL_ROUTES: "",
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
                url: provider.url.href,
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
    try {
      let output = ""
      let url = ""
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`title server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const sessionID = "ses_title_mid_run"
      expect(
        (
          await fetch(url + "/api/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: sessionID, location: { directory } }),
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(url + `/api/session/${sessionID}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: `msg_${sessionID}`, prompt: { text: "Find the failing step" } }),
          })
        ).status,
      ).toBe(200)
      const deadline = Date.now() + 30_000
      let title: string | undefined
      let busy = false
      while (Date.now() < deadline) {
        // A snapshot is what projects a title the engine accepted onto the
        // product row, and the status route is the snapshot the TUI takes
        // while a run is in flight.
        const status = await (await fetch(url + `/api/session/${sessionID}/status`, { headers })).json()
        busy = status.data.type !== "idle"
        const info = await (await fetch(url + `/api/session/${sessionID}`, { headers })).json()
        title = info.data.title
        if (title === "Mid-run title") break
        await Bun.sleep(50)
      }
      expect(title).toBe("Mid-run title")
      // The run was still going when the title landed: this is what a title
      // generated only at idle cannot do for a Session that stays busy.
      expect(busy).toBe(true)
      expect(state.finish).toBe(false)
      state.finish = true
      const ended = Date.now() + 20_000
      while (Date.now() < ended) {
        const settled = await (await fetch(url + `/api/session/${sessionID}/status`, { headers })).json()
        if (settled.data.type === "idle") return
        await Bun.sleep(50)
      }
      throw new Error("the run never finished after the fixture was told to stop")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await stderr
      provider.stop(true)
    }
  },
  90_000,
)
