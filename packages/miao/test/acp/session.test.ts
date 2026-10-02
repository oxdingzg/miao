import { describe, expect } from "bun:test"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { mkdir } from "node:fs/promises"
import { verifierConfig, verifierSkill } from "../cli/acp/helpers"
import { allowOnce, connect, reject, until } from "./harness"

const source = [
  "class A {",
  "  method() {",
  "    a()",
  "    b()",
  "    c()",
  "    d()",
  "    e()",
  "    f()",
  "    g()",
  "  }",
  "}",
  "",
].join("\n")
const edited = source.replace("    d()", "    D()")

const config = (llm: string, skills?: string) => ({
  ...verifierConfig(llm, skills),
  permission: { edit: "ask", bash: "ask", todowrite: "allow" },
})

describe("acp V2 adapter", () => {
  cliIt.live(
    "drives a session: stream, approve with diff, reject, plan, cancel, switch, list, fork, reload",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({ env: { MIAO_CONFIG_CONTENT: JSON.stringify(config(llm.url)) } })
        const v2 = OpenCode.make({ baseUrl: server.url })
        const acp = yield* connect(server.url)
        yield* Effect.promise(() => Bun.write(path.join(home, "a.ts"), source))

        const created = yield* Effect.promise(() => acp.conn.newSession({ cwd: home, mcpServers: [] }))
        const sessionId = created.sessionId
        expect(created.configOptions?.map((option) => [option.id, option.currentValue])).toEqual([
          ["model", "test/test-model"],
          ["effort", "low"],
          ["mode", "build"],
        ])
        expect((yield* Effect.promise(() => v2.sessions.get({ sessionID: sessionId }))).model).toEqual({
          providerID: "test",
          id: "test-model",
          variant: "low",
        })
        yield* Effect.promise(() => until(() => acp.of(sessionId, "available_commands_update").length > 0, "commands"))

        // Streamed reasoning and text.
        yield* llm.reason("thinking it over", { text: "hello there" })
        const first = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
        )
        expect(first.stopReason).toBe("end_turn")
        expect(acp.text(sessionId, "agent_thought_chunk")).toBe("thinking it over")
        expect(acp.text(sessionId, "agent_message_chunk")).toBe("hello there")
        expect(acp.of(sessionId, "usage_update").at(-1)?.size).toBe(100_000)

        // An edit asks with a diff, previews the new text, and lands on disk.
        yield* llm.push(reply().tool("edit", { path: "a.ts", oldString: "    d()", newString: "    D()" }))
        yield* llm.text("edited")
        const second = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "edit it" }] }),
        )
        expect(second.stopReason).toBe("end_turn")
        const ask = acp.permissions.at(-1)
        expect(ask?.options.map((option) => option.optionId)).toEqual(["once", "always", "reject"])
        expect(ask?.toolCall.kind).toBe("edit")
        expect(ask?.toolCall.content).toEqual([
          { type: "diff", path: path.join(home, "a.ts"), oldText: source, newText: edited },
        ])
        expect(acp.writes).toEqual([{ sessionId, path: path.join(home, "a.ts"), content: edited }])
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "a.ts")).text())).toBe(edited)
        const editCall = ask?.toolCall.toolCallId
        expect(
          acp.of(sessionId, "tool_call").some((call) => call.toolCallId === editCall && call.kind === "edit"),
        ).toBe(true)
        expect(
          acp
            .of(sessionId, "tool_call_update")
            .some((update) => update.toolCallId === editCall && update.status === "completed"),
        ).toBe(true)

        // Declining a command halts the turn (as V1 did) and fails its tool call.
        acp.policy.answer = reject
        yield* llm.push(reply().tool("bash", { command: "echo should-not-run" }))
        const third = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "run it" }] }),
        )
        expect(third.stopReason).toBe("end_turn")
        const bashCall = acp.permissions.at(-1)?.toolCall
        expect(bashCall?.title).toBe("echo should-not-run")
        expect(
          acp
            .of(sessionId, "tool_call_update")
            .some((update) => update.toolCallId === bashCall?.toolCallId && update.status === "failed"),
        ).toBe(true)
        acp.policy.answer = allowOnce

        // Todos become an ACP plan.
        yield* llm.push(
          reply().tool("todowrite", {
            todos: [
              { content: "step one", status: "in_progress", priority: "high" },
              { content: "step two", status: "pending", priority: "low" },
            ],
          }),
        )
        yield* llm.text("planned")
        yield* Effect.promise(() => acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "plan it" }] }))
        expect(acp.of(sessionId, "plan").at(-1)?.entries).toEqual([
          { content: "step one", status: "in_progress", priority: "high" },
          { content: "step two", status: "pending", priority: "low" },
        ])

        // Cancel interrupts a hanging provider turn.
        const calls = yield* llm.calls
        yield* llm.hang
        const pending = acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "take forever" }] })
        yield* llm.wait(calls + 1)
        yield* Effect.promise(() => acp.conn.cancel({ sessionId }))
        expect((yield* Effect.promise(() => pending)).stopReason).toBe("cancelled")

        // Mode, effort and model switches reach the V2 session.
        yield* Effect.promise(() => acp.conn.setSessionMode({ sessionId, modeId: "plan" }))
        const effort = yield* Effect.promise(() =>
          acp.conn.setSessionConfigOption({ sessionId, configId: "effort", value: "high" }),
        )
        expect(effort.configOptions.find((option) => option.id === "effort")?.currentValue).toBe("high")
        expect((yield* Effect.promise(() => v2.sessions.get({ sessionID: sessionId }))).model?.variant).toBe("high")
        yield* Effect.promise(() => acp.conn.unstable_setSessionModel({ sessionId, modelId: "test/second-model" }))
        const switched = yield* Effect.promise(() => v2.sessions.get({ sessionID: sessionId }))
        expect(switched.agent).toBe("plan")
        expect(switched.model?.id).toBe("second-model")
        expect(acp.of(sessionId, "config_option_update").length).toBeGreaterThan(0)

        // List and fork.
        const listed = yield* Effect.promise(() => acp.conn.listSessions({ cwd: home }))
        expect(listed.sessions.some((item) => item.sessionId === sessionId)).toBe(true)
        const fork = yield* Effect.promise(() =>
          acp.conn.unstable_forkSession({ sessionId, cwd: home, mcpServers: [] }),
        )
        expect(fork.sessionId).not.toBe(sessionId)
        expect(acp.text(fork.sessionId, "user_message_chunk")).toContain("edit it")
        expect(acp.text(fork.sessionId, "agent_message_chunk")).toContain("hello there")

        // A new editor connection reloads the whole history.
        const reload = yield* connect(server.url)
        const loaded = yield* Effect.promise(() => reload.conn.loadSession({ sessionId, cwd: home, mcpServers: [] }))
        expect(loaded.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/second-model")
        expect(loaded.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
        expect(
          reload
            .of(sessionId, "user_message_chunk")
            .map((item) => (item.content.type === "text" ? item.content.text : "")),
        ).toEqual(["hi", "edit it", "run it", "plan it", "take forever"])
        expect(reload.text(sessionId, "agent_thought_chunk")).toBe("thinking it over")
        expect(reload.text(sessionId, "agent_message_chunk")).toContain("hello there")
        const replayedEdit = reload.of(sessionId, "tool_call_update").find((update) => update.kind === "edit")
        expect(replayedEdit?.status).toBe("completed")
        expect(replayedEdit?.content?.some((item) => item.type === "diff" && item.newText === "    D()")).toBe(true)
        expect(
          reload
            .of(sessionId, "tool_call_update")
            .some((update) => update.kind === "execute" && update.status === "failed"),
        ).toBe(true)
        expect(reload.of(sessionId, "plan").at(-1)?.entries.length).toBe(2)
      }),
    120_000,
  )

  cliIt.live(
    "answers questions, asks for subagents through the parent, runs skills and compacts",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const skills = path.join(home, "skills")
        yield* Effect.promise(() => mkdir(path.join(skills, "verifier-skill"), { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(skills, "verifier-skill", "SKILL.md"), verifierSkill))
        const server = yield* opencode.serve({
          env: { MIAO_CONFIG_CONTENT: JSON.stringify(config(llm.url, skills)) },
        })
        const acp = yield* connect(server.url)
        const { sessionId } = yield* Effect.promise(() => acp.conn.newSession({ cwd: home, mcpServers: [] }))

        acp.policy.answer = (request) =>
          request.options.some((option) => option.optionId === "1")
            ? { outcome: { outcome: "selected", optionId: "1" } }
            : allowOnce(request)
        yield* llm.push(
          reply().tool("question", {
            questions: [
              {
                question: "Which color?",
                header: "Color",
                options: [
                  { label: "Red", description: "warm" },
                  { label: "Blue", description: "cool" },
                ],
              },
            ],
          }),
        )
        yield* llm.text("blue it is")
        const result = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "ask me" }] }),
        )
        expect(result.stopReason).toBe("end_turn")
        expect(acp.permissions.at(-1)?.toolCall.title).toBe("Which color?")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1))).toContain("Blue")

        // A subagent's permission request is asked on the parent's ACP session.
        acp.policy.answer = allowOnce
        yield* llm.push(
          reply().tool("task", { description: "sub run", prompt: "run the marker", subagent_type: "general" }),
        )
        yield* llm.push(reply().tool("bash", { command: "echo from-subagent" }))
        yield* llm.text("sub done")
        yield* llm.text("parent done")
        const delegated = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "delegate" }] }),
        )
        expect(delegated.stopReason).toBe("end_turn")
        expect(
          acp.permissions.some(
            (request) => request.sessionId === sessionId && request.toolCall.title?.includes("echo from-subagent"),
          ),
        ).toBe(true)

        // A skill slash command loads the skill, then prompts with the rest of the line.
        yield* llm.text("skill used")
        const skilled = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/verifier-skill check the build" }] }),
        )
        expect(skilled.stopReason).toBe("end_turn")
        const request = JSON.stringify((yield* llm.inputs).at(-1))
        expect(request).toContain("Verifier Skill")
        expect(request).toContain("check the build")

        // /compact asks V2 for a manual compaction instead of sending the text to the model. (With
        // this little history the compactor keeps everything as recent context, so it is a no-op.)
        const calls = yield* llm.calls
        const compacted = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/compact" }] }),
        )
        expect(compacted.stopReason).toBe("end_turn")
        expect(yield* llm.calls).toBe(calls)
        const messages = yield* Effect.promise(() =>
          OpenCode.make({ baseUrl: server.url }).messages.list({ sessionID: sessionId, limit: 5 }),
        )
        expect(messages.data.some((message) => message.type === "user" && message.text === "/compact")).toBe(false)
      }),
    60_000,
  )
})
