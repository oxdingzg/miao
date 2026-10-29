import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native product tools settle a host-owned Session tool", () => {})

if (binary)
  for (const [toolName, outcome] of [
    ["list_sessions", "success"],
    ["workflow", "success"],
    ["workflow", "denied"],
    ["workflow", "cancel-peer"],
    ["switch_workspace", "success"],
    ["switch_workspace", "missing"],
    ["switch_workspace", "denied"],
    ["switch_workspace", "same"],
  ] as const)
    test(`native product tools settle ${toolName} (${outcome}) through the host`, async () => {
      await using tmp = await tmpdir()
      const directory = path.join(tmp.path, "project")
      const destination = path.join(tmp.path, "other-project")
      await Bun.$`mkdir -p ${directory}`.quiet()
      await Bun.$`mkdir -p ${destination}`.quiet()
      await Bun.write(path.join(destination, "workspace-marker.txt"), "destination-workspace-marker")
      await Bun.write(path.join(destination, "AGENTS.md"), "Workspace instruction: destination-only-instruction")
      const policyFile = path.join(tmp.path, "policy.json")
      await Bun.write(policyFile, JSON.stringify({ mode: "workspace" }))
      const tools: string[] = []
      let calls = 0
      let childCalls = 0
      const releaseChildren = Promise.withResolvers<void>()
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
          if (childTurn && outcome === "cancel-peer") {
            childCalls++
            await releaseChildren.promise
          }
          const first = !childTurn && !body.messages.some((message) => message.role === "tool")
          const switched =
            toolName === "switch_workspace" &&
            outcome === "success" &&
            !first &&
            !body.messages.some(
              (message) =>
                message.role === "tool" && JSON.stringify(message.content).includes("destination-workspace-marker"),
            )
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
                        toolName === "switch_workspace"
                          ? {
                              directory:
                                outcome === "same"
                                  ? directory
                                  : outcome === "missing"
                                    ? path.join(tmp.path, "missing")
                                    : destination,
                            }
                          : toolName === "list_sessions"
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
            : switched
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "destination-read",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "workspace-marker.txt" }),
                      },
                    },
                  ],
                }
              : { content: childTurn ? "workflow-child-acceptance" : "completed-product-tool-turn" }
          return new Response(
            `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first || switched ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
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
            permission:
              outcome === "denied"
                ? toolName === "workflow"
                  ? { "*": "allow", task: { "*": "allow", explore: "deny" } }
                  : { "*": "allow", external_directory: "deny" }
                : "allow",
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
      const timer = setTimeout(() => child.kill(), 80_000)
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
        if (outcome === "cancel-peer") {
          const second = await fetch(url + "/api/session/" + peer.id + "/prompt", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "msg_native_product_peer", prompt: { text: "delegate concurrently" } }),
          })
          expect(second.status).toBe(200)
          const deadline = Date.now() + 15_000
          while (childCalls < 2 && Date.now() < deadline) await Bun.sleep(50)
          expect(childCalls).toBe(2)
          using db = new Database(path.join(tmp.path, "miao.db"), { readonly: true })
          const children = db.query<{ id: string; parent_id: string }, []>(
            "select id, parent_id from session where parent_id is not null",
          ).all()
          expect(children).toHaveLength(2)
          const stopped = children.find((child) => child.parent_id === target.id)
          const live = children.find((child) => child.parent_id === peer.id)
          if (!stopped || !live) throw new Error("concurrent workflow children are missing")
          const placement = db.query<{ native_storage: string }, [string]>(
            "select native_storage from session_engine_placement where session_id = ?",
          ).get(target.id)
          if (!placement) throw new Error("native placement is missing")
          using native = new Database(placement.native_storage, { readonly: true })
          const running = (id: string) => native.query<{ count: number }, [string]>(
            "select count(*) as count from engine_run where session_id = ? and state = 'running'",
          ).get(id)?.count ?? 0
          expect(running(stopped.id)).toBe(1)
          expect(running(live.id)).toBe(1)
          const cancelled = await fetch(url + "/api/session/" + target.id + "/interrupt", {
            method: "POST", headers,
          })
          expect(cancelled.status).toBe(204)
          const cancellationDeadline = Date.now() + 5_000
          while (running(stopped.id) && Date.now() < cancellationDeadline) await Bun.sleep(50)
          expect(running(stopped.id)).toBe(0)
          expect(running(live.id)).toBe(1)
          releaseChildren.resolve()
          let history = ""
          while (Date.now() < deadline) {
            const response = await fetch(url + "/api/session/" + peer.id + "/history", { headers })
            history = await response.text()
            if (history.includes("completed-product-tool-turn")) break
            await Bun.sleep(50)
          }
          expect(history).toContain("completed-product-tool-turn")
          const response = await fetch(url + "/api/session/" + target.id + "/history", { headers })
          expect(await response.text()).not.toContain("completed-product-tool-turn")
          return
        }
        const deadline = Date.now() + 60_000
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
        if (!context.ok) throw new Error(`native context HTTP ${context.status}: ${await context.text()}`)
        expect(context.status).toBe(200)
        const transcript = await context.json()
        const rendered = JSON.stringify(transcript.data)
        if (outcome === "success")
          expect(rendered).toContain(
            toolName === "switch_workspace"
              ? "destination-workspace-marker"
              : toolName === "list_sessions"
                ? peer.id
                : "workflow-child-acceptance",
          )
        if (toolName === "switch_workspace") {
          using db = new Database(path.join(tmp.path, "miao.db"), { readonly: true })
          const placement = db
            .query<{ location: string }, [string]>("select location from session_engine_placement where session_id = ?")
            .get(target.id)
          const expected = outcome === "success" ? destination : directory
          expect(JSON.parse(placement?.location ?? "{}").directory).toBe(await realpath(expected))
          const catalog = db
            .query<{ directory: string }, [string]>("select directory from session where id = ?")
            .get(target.id)
          expect(await realpath(catalog?.directory ?? "")).toBe(await realpath(expected))
          expect(rendered).toContain("switch_workspace")
          expect(rendered).not.toContain("path is outside the configured workspace")
          if (outcome === "denied" || outcome === "missing") {
            expect(db.query("select * from session_migration").all()).toHaveLength(0)
          }
        }
        if (toolName === "workflow") {
          using db = new Database(path.join(tmp.path, "miao.db"), { readonly: true })
          const children = db
            .query<{ id: string }, [string]>("select id from session where parent_id = ?")
            .all(target.id)
          expect(children).toHaveLength(outcome === "denied" ? 0 : 1)
          const spawned = children.at(0)
          if (outcome === "success") {
            if (!spawned) throw new Error("workflow child was not projected")
            const result = await fetch(url + "/api/session/" + spawned.id + "/context", { headers })
            expect(result.status).toBe(200)
            expect(await result.text()).toContain("workflow-child-acceptance")
          }
        }
        const states = transcript.data.flatMap(
          (message: { content?: { type: string; state?: { status: string } }[] }) =>
            message.content?.filter((part) => part.type === "tool").map((part) => part.state?.status) ?? [],
        )
        expect(states).toContain(outcome === "denied" || outcome === "missing" ? "error" : "completed")
        expect(calls).toBe(
          (toolName === "workflow" || toolName === "switch_workspace") && outcome === "success" ? 3 : 2,
        )
        expect(tools).toContain("workflow")
      } finally {
        releaseChildren.resolve()
        clearTimeout(timer)
        child.kill()
        await child.exited
        await stderr
        provider.stop(true)
      }
    }, 80_000)
