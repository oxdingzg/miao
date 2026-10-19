import { expect, test } from "bun:test"
import path from "path"
import { Schema } from "effect"
import { AgentAttachment, CommandInvocation, FileAttachment } from "@miao/schema/prompt"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const View = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      text: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
      commandState: Schema.optional(Schema.String),
      commandError: Schema.optional(Schema.String),
      command: Schema.optional(Schema.Union([CommandInvocation, Schema.String])),
      files: Schema.optional(Schema.Array(FileAttachment)),
      agents: Schema.optional(Schema.Array(AgentAttachment)),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
})

test.skipIf(!binary)(
  "native commands prepare in the actor, preserve chips/references, and bind named child agents",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    const template = "漢😀 check $1 !`printf x >> effects; printf shell-ready` @fixture.txt @worker"
    await Bun.write(
      path.join(directory, "miao.jsonc"),
      JSON.stringify({
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        agents: {
          worker: {
            system: "COMMAND_WORKER_SYSTEM",
            mode: "subagent",
            model: "native-engine/base",
            request: { headers: { "x-command-agent": "worker" }, body: { temperature: 0.25 } },
          },
          guarded: { mode: "subagent", permissions: [{ action: "read", resource: "*", effect: "deny" }] },
        },
        commands: {
          inspect: { template, agent: "worker", model: "native-engine/alternate", variant: "high", subtask: false },
          delegated: { template: "SUBTASK_INPUT_9831 @fixture.txt", agent: "worker", subtask: true },
          defaults: { template: "use the agent model default", agent: "worker", subtask: false },
          denied: { template: "read @fixture.txt", agent: "guarded", subtask: false },
        },
      }),
    )
    await Bun.write(path.join(directory, "fixture.txt"), "CAPTURED_FILE_BODY")
    const received: { body: string; agent: string | null }[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text()
        received.push({ body, agent: request.headers.get("x-command-agent") })
        const text = body.includes("SUBTASK_INPUT_9831") ? "child-answer" : "done"
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const routes = path.join(tmp.path, "routes.json")
    await Bun.write(
      routes,
      JSON.stringify([
        {
          id: "base",
          provider: "openai-chat",
          model: "fixture-base",
          primary: true,
          endpoint: `http://127.0.0.1:${upstream.port}/base`,
          credential: { type: "environment", key: "OPENAI_API_KEY" },
        },
        {
          id: "alternate",
          provider: "openai-chat",
          model: "fixture-alt",
          endpoint: `http://127.0.0.1:${upstream.port}/alternate`,
          credential: { type: "environment", key: "OPENAI_API_KEY" },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
        },
      ]),
    )
    const policy = path.join(tmp.path, "policy.json")
    await Bun.write(
      policy,
      JSON.stringify({
        mode: "workspace",
        allow_process: true,
        allow_subagents: true,
        rules: [{ tool: "*", path: "**", decision: "allow" }],
      }),
    )
    const child = Bun.spawn({
      cmd: [
        "bun",
        path.resolve(import.meta.dir, "../../src/index.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      cwd: directory,
      env: {
        ...process.env,
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_POLICY: policy,
        MIAO_ENGINE_MODEL_ROUTES_CONFIG: routes,
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_DB: path.join(tmp.path, "product.db"),
        MIAO_PURE: "1",
        OPENAI_API_KEY: "fixture",
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture-base",
        MIAO_ENGINE_ENDPOINT: `http://127.0.0.1:${upstream.port}/base`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const stderr = new Response(child.stderr).text()
    try {
      const reader = child.stdout.getReader()
      let output = ""
      const url = await (async () => {
        const deadline = Date.now() + 25000
        while (Date.now() < deadline) {
          const item = await reader.read()
          if (item.done) break
          output += new TextDecoder().decode(item.value)
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (match) return match[0]
        }
        throw new Error(`server did not start: ${output}\n${await stderr}`)
      })()
      const headers = {
        "content-type": "application/json",
        "x-opencode-directory": directory,
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const id = "ses_native_command"
      const sessionPath = url + `/api/session/${id}`
      const created = await fetch(url + "/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ id, location: { directory } }),
      })
      expect(created.status).toBe(200)
      const context = async () =>
        Schema.decodeUnknownSync(View)(await (await fetch(sessionPath + "/context", { headers })).json()).data
      const command = (id: string, name: string, args = "", resume = true) =>
        fetch(sessionPath + "/command", {
          method: "POST",
          headers,
          body: JSON.stringify({ id, command: name, arguments: args, resume }),
        })
      const settle = async (id: string, state = "completed") => {
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          const data = await context()
          const message = data.find((item) => item.id === id)
          if (
            message?.commandState === state &&
            data
              .slice(data.findIndex((item) => item.id === id) + 1)
              .some(
                (item) =>
                  item.type === "assistant" &&
                  item.content?.some((part) => part.type === "text" && part.text?.includes("done")),
              )
          )
            return message
          await Bun.sleep(20)
        }
        throw new Error(`command ${id} did not ${state}: ${JSON.stringify(await context())}`)
      }
      const admitted = await command("msg_inspect", "inspect", "topic", false)
      if (admitted.status !== 204) throw new Error(`${admitted.status}: ${await admitted.text()}`)
      expect(admitted.status).toBe(204)
      expect(await Bun.file(path.join(directory, "effects")).exists()).toBe(false)
      expect(received).toHaveLength(0)
      expect(
        (
          await fetch(sessionPath + "/prompt", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "msg_continue", prompt: { text: "continue" } }),
          })
        ).status,
      ).toBe(200)
      const prepared = await settle("msg_inspect")
      expect(prepared.command).toMatchObject({
        name: "inspect",
        arguments: "topic",
        agent: "worker",
        model: { providerID: "native-engine", id: "alternate", variant: "high" },
        subtask: false,
      })
      expect(prepared.text).toContain("check topic shell-ready")
      expect(prepared.text).not.toContain("!`")
      expect(prepared.files?.[0]).toMatchObject({
        name: "fixture.txt",
        mime: "text/plain",
        source: { text: "@fixture.txt", start: prepared.text?.indexOf("@fixture.txt") },
      })
      expect(prepared.agents?.[0].name).toBe("worker")
      expect(received[0].body).toContain('"model":"fixture-alt"')
      expect(received[0].body).toContain('"reasoning_effort":"high"')
      expect(received[0].body).toContain("COMMAND_WORKER_SYSTEM")
      expect(received[0].body).toContain("CAPTURED_FILE_BODY")
      expect(received[0].agent).toBe("worker")
      expect(await Bun.file(path.join(directory, "effects")).text()).toBe("x")
      expect((await command("msg_inspect", "inspect", "topic")).status).toBe(204)
      expect((await command("msg_inspect", "inspect", "changed")).status).toBe(409)
      await Bun.sleep(80)
      expect(received).toHaveLength(1)
      expect(await Bun.file(path.join(directory, "effects")).text()).toBe("x")
      const fork = await fetch(sessionPath + "/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({ messageID: "msg_inspect" }),
      })
      if (fork.status !== 200) throw new Error(`fork failed ${fork.status}: ${await fork.text()}`)
      expect(fork.status).toBe(200)
      const forked = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
        await fork.json(),
      )
      const copied = Schema.decodeUnknownSync(View)(
        await (await fetch(url + `/api/session/${forked.data.id}/context`, { headers })).json(),
      ).data
      expect(copied.filter((item) => item.type === "user")).toHaveLength(1)
      expect(copied.find((item) => item.type === "user")).toMatchObject({
        commandState: "completed",
        command: { name: "inspect" },
        text: prepared.text,
      })
      expect(copied.some((item) => item.type === "shell" && item.metadata?.origin === "operator")).toBe(true)
      const mentions = [
        { name: "worker", source: { start: 0, end: 7, text: "@worker" } },
        { name: "worker", source: { start: 10, end: 17, text: "@worker" } },
      ]
      expect(
        (
          await fetch(sessionPath + "/prompt", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: "msg_agents", prompt: { text: "@worker / @worker", agents: mentions } }),
          })
        ).status,
      ).toBe(200)
      const deadline = Date.now() + 15000
      while (received.length < 2 && Date.now() < deadline) await Bun.sleep(20)
      expect((await context()).find((item) => item.id === "msg_agents")?.agents).toEqual(mentions)
      expect((await command("msg_subtask", "delegated")).status).toBe(204)
      await settle("msg_subtask")
      const finished = await context()
      expect(finished.find((item) => item.id === "msg_subtask")?.text).toContain("completed in child Session")
      expect(finished.find((item) => item.id === "msg_subtask")?.text).toContain("child-answer")
      expect(
        received.some(
          (item) =>
            item.body.includes("SUBTASK_INPUT_9831") &&
            item.body.includes('"model":"fixture-base"') &&
            item.agent === "worker",
        ),
      ).toBe(true)
      expect((await command("msg_defaults", "defaults")).status).toBe(204)
      await settle("msg_defaults")
      expect(received.at(-1)?.body).toContain('"model":"fixture-base"')
      expect((await command("msg_denied", "denied")).status).toBe(204)
      const denied = await settle("msg_denied", "failed")
      expect(denied.commandError).toContain("refused")
      expect(await Bun.file(path.join(directory, "effects")).text()).toBe("x")
    } catch (error) {
      child.kill()
      throw new Error(`${String(error)}\nServer diagnostics:\n${await stderr}`, { cause: error })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      await upstream.stop(true)
    }
  },
  70_000,
)
