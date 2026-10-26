import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native file edits reach the transcript as a diff", () => {})

const notes = "alpha\nbeta\ngamma\n"

/**
 * The engine already holds the text a mutation wrote, so its host renders the
 * diff from the transcript while the model never receives it twice. This drives
 * one real edit through the product surface and asserts both halves.
 */
if (binary)
  test(
    "native file edits reach the transcript as a diff",
    async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "project")
      await Bun.$`mkdir -p ${directory}`.quiet()
      const file = path.join(directory, "notes.md")
      await Bun.write(file, notes)
      const policyFile = path.join(tmp.path, "policy.json")
      await Bun.write(policyFile, JSON.stringify({ mode: "workspace" }))
      const digest = new Bun.CryptoHasher("sha256").update(notes).digest("hex")
      const sent: string[] = []
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json()
          const text = JSON.stringify(body)
          sent.push(text)
          const answered = body.messages.some((message: { role: string }) => message.role === "tool")
          const delta = answered
            ? { role: "assistant", content: "edited-display-fixture" }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "edit-call",
                    type: "function",
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: "notes.md",
                        old_string: "beta",
                        new_string: "BETA",
                        expected_sha256: digest,
                      }),
                    },
                  },
                ],
              }
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: answered ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
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
          MIAO_ENGINE_POLICY: policyFile,
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
            permission: "allow",
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
            lsp: false,
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const timer = setTimeout(() => child.kill(), 40_000)
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
        const created = await fetch(url + "/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "ses_native_display", location: { directory } }),
        })
        expect(created.status).toBe(200)
        const prompt = await fetch(url + "/api/session/ses_native_display/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_native_display", prompt: { text: "rename beta" } }),
        })
        expect(prompt.status).toBe(200)
        const deadline = Date.now() + 20_000
        let history = ""
        while (Date.now() < deadline) {
          const response = await fetch(url + "/api/session/ses_native_display/history", { headers })
          if (!response.ok) throw new Error(`native history HTTP ${response.status}`)
          history = await response.text()
          if (history.includes("edited-display-fixture")) break
          await Bun.sleep(50)
        }
        expect(history).toContain("edited-display-fixture")
        const context = await fetch(url + "/api/session/ses_native_display/context", { headers })
        expect(context.status).toBe(200)
        const transcript = await context.json()
        const edit = transcript.data
          .flatMap((message: { content?: { type: string; name?: string; state?: unknown }[] }) => message.content ?? [])
          .find((part: { type: string; name?: string }) => part.type === "tool" && part.name === "edit")
        expect(edit).toBeDefined()
        const state = edit.state as {
          status: string
          input: Record<string, unknown>
          structured: { files?: { file?: string; patch?: string; additions?: number; deletions?: number; status?: string }[] }
        }
        expect(state.status).toBe("completed")
        expect(state.input.path).toBe("notes.md")
        expect(state.structured.files).toHaveLength(1)
        expect(state.structured.files?.[0]?.file).toBe("notes.md")
        expect(state.structured.files?.[0]?.additions).toBe(1)
        expect(state.structured.files?.[0]?.deletions).toBe(1)
        expect(state.structured.files?.[0]?.status).toBe("modified")
        const patch = state.structured.files?.[0]?.patch ?? ""
        expect(patch).toContain("-beta\n+BETA\n")
        expect(patch.startsWith("Index: notes.md\n")).toBe(true)
        expect(await Bun.file(file).text()).toBe("alpha\nBETA\ngamma\n")
        // The model already wrote that text; the diff must not be sent back to it.
        expect(sent).toHaveLength(2)
        expect(sent[1]).not.toContain("_display")
        expect(sent[1]).not.toContain("-beta\\n+BETA")
      } finally {
        clearTimeout(timer)
        child.kill()
        await child.exited
        await stderr
        provider.stop(true)
      }
    },
    40_000,
  )
