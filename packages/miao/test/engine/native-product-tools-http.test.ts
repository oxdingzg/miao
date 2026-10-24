import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native product tools settle a host-owned Session tool", () => {})

if (binary)
  for (const toolName of ["list_sessions", "workflow"] as const)
    test(`native product tools settle ${toolName} through the host`, async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "project")
      await Bun.$`mkdir -p ${directory}`.quiet()
      const policyFile = path.join(tmp.path, "policy.json")
      await Bun.write(policyFile, JSON.stringify({ mode: "workspace" }))
      const tools: string[] = []
      let calls = 0
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          calls++
          const body = (await request.json()) as {
            messages: Array<{ role: string; content?: unknown }>
            tools?: Array<{ function: { name: string } }>
          }
          tools.push(...(body.tools ?? []).map((tool) => tool.function.name))
          const childTurn = body.messages.some(
            (message) =>
              message.role === "user" && JSON.stringify(message.content).includes("workflow-child-acceptance"),
          )
          const first = !childTurn && !body.messages.some((message) => message.role === "tool")
          const delta = first
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "list-call",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(
                        toolName === "list_sessions"
                          ? { includeHistory: true }
                          : {
                              script:
                                'return await tools.workflow.agent({agent:"explore",description:"Fixture child",prompt:"Reply workflow-child-acceptance"})',
                            },
                      ),
                    },
                  },
                ],
              }
            : { content: childTurn ? "workflow-child-acceptance" : "completed-product-tool-turn" }
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
        const create = async (id: string) => {
          const response = await fetch(url + "/api/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ id, location: { directory } }),
          })
          expect(response.status).toBe(200)
          return (await response.json()).data as { id: string }
        }
        const peer = await create("ses_product_peer")
        const target = await create("ses_product_target")
        const prompt = await fetch(url + "/api/session/" + target.id + "/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_native_product", prompt: { text: "list the other sessions" } }),
        })
        expect(prompt.status).toBe(200)
        const deadline = Date.now() + 20_000
        let history = ""
        while (Date.now() < deadline) {
          const response = await fetch(url + "/api/session/" + target.id + "/history", { headers })
          if (!response.ok) throw new Error(`native history HTTP ${response.status}`)
          history = await response.text()
          if (history.includes("completed-product-tool-turn")) break
          await Bun.sleep(50)
        }
        expect(history).toContain("completed-product-tool-turn")
        const context = await fetch(url + "/api/session/" + target.id + "/context", { headers })
        expect(context.status).toBe(200)
        const transcript = await context.json()
        const rendered = JSON.stringify(transcript.data)
        expect(rendered).toContain(toolName === "list_sessions" ? peer.id : "workflow-child-acceptance")
        if (toolName === "workflow") {
          using db = new Database(path.join(tmp.path, "miao.db"), { readonly: true })
          const children = db
            .query<{ id: string }, [string]>("select id from session where parent_id = ?")
            .all(target.id)
          expect(children).toHaveLength(1)
          const spawned = children.at(0)
          if (!spawned) throw new Error("workflow child was not projected")
          const result = await fetch(url + "/api/session/" + spawned.id + "/context", { headers })
          expect(result.status).toBe(200)
          expect(await result.text()).toContain("workflow-child-acceptance")
        }
        const states = transcript.data.flatMap(
          (message: { content?: { type: string; state?: { status: string } }[] }) =>
            message.content?.filter((part) => part.type === "tool").map((part) => part.state?.status) ?? [],
        )
        expect(states).toContain("completed")
        expect(calls).toBe(toolName === "list_sessions" ? 2 : 3)
        expect(tools).toContain("workflow")
      } finally {
        clearTimeout(timer)
        child.kill()
        await child.exited
        await stderr
        provider.stop(true)
      }
    }, 40_000)
