import { describe, expect, test } from "bun:test"
import { entryBody } from "@/cli/cmd/run/entry.body"
import type { SessionDataEvent } from "@/cli/cmd/run/session-data"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  createSubagentData,
  reduceSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"

type SessionMessage = Parameters<typeof bootstrapSubagentData>[0]["messages"][number]
type ChildMessage = Parameters<typeof bootstrapSubagentCalls>[0]["messages"][number]

function visible(commits: Array<Parameters<typeof entryBody>[0]>) {
  return commits.flatMap((item) => {
    const body = entryBody(item)
    if (body.type === "none") {
      return []
    }

    if (body.type === "structured") {
      if (body.snapshot.kind === "code" || body.snapshot.kind === "task") {
        return [body.snapshot.title]
      }

      if (body.snapshot.kind === "diff") {
        return body.snapshot.items.map((item) => item.title)
      }

      if (body.snapshot.kind === "todo") {
        return ["# Todos"]
      }

      return ["# Questions"]
    }

    return [body.content]
  })
}

function reduce(data: ReturnType<typeof createSubagentData>, event: unknown) {
  return reduceSubagentData({
    data,
    event: event as SessionDataEvent,
    sessionID: "parent-1",
    thinking: true,
    limits: {},
  })
}

function taskMessage(sessionID: string, status: "running" | "completed" | "interrupted" = "completed"): SessionMessage {
  if (status === "running") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            title: "Reducer touchpoints",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
            },
            time: { start: 1 },
          },
        },
      ],
    }
  }

  if (status === "interrupted") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "error",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            error: "Tool execution aborted",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
              interrupted: true,
            },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
  }

  return {
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `call-${sessionID}`,
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Scan reducer paths",
            subagent_type: "explore",
          },
          output: "",
          title: "Reducer touchpoints",
          metadata: {
            sessionId: sessionID,
            toolcalls: 4,
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "Fast", description: "Quick pass" }],
        multiSelect: false,
      },
    ],
  }
}

function childMessage(input: {
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  parts: ChildMessage["parts"]
}) {
  if (input.role === "user") {
    return {
      info: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: {
          created: 1,
        },
        agent: "test",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
      parts: input.parts,
    } satisfies ChildMessage
  }

  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 2,
        completed: 3,
      },
      parentID: "msg-user-1",
      providerID: "openai",
      modelID: "gpt-5",
      mode: "default",
      agent: "explore",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      finish: "stop",
    },
    parts: input.parts,
  } satisfies ChildMessage
}

describe("run subagent data", () => {
  test("bootstraps tabs and child blockers from parent task parts", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [taskMessage("child-1")],
        children: [{ id: "child-1" }, { id: "child-2" }],
        permissions: [
          {
            id: "perm-1",
            sessionID: "child-1",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
          {
            id: "perm-2",
            sessionID: "other",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
        ],
        questions: [question("question-1", "child-1"), question("question-2", "other")],
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        label: "Explore",
        description: "Scan reducer paths",
        title: "Reducer touchpoints",
        status: "completed",
        toolCalls: 4,
      }),
    ])
    expect(snapshot.details).toEqual({
      "child-1": {
        sessionID: "child-1",
        commits: [],
      },
    })
    expect(snapshot.permissions.map((item) => item.id)).toEqual(["perm-1"])
    expect(snapshot.questions.map((item) => item.id)).toEqual(["question-1"])
  })

  test("marks interrupted task tabs as cancelled during bootstrap", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "interrupted")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })

  test("captures child activity and blocker metadata in the footer detail state", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    const child = (type: string, properties: Record<string, unknown>) =>
      reduce(data, { type, properties: { sessionID: "child-1", timestamp: 1, ...properties } })
    child("session.next.prompted", {
      messageID: "msg-user-1",
      prompt: { text: "Inspect footer tabs" },
      delivery: "steer",
    })
    child("session.next.step.started", {
      assistantMessageID: "msg-assistant-1",
      agent: "explore",
      model: { providerID: "openai", id: "gpt-5" },
    })
    child("session.next.reasoning.started", { assistantMessageID: "msg-assistant-1", reasoningID: "reason-1" })
    child("session.next.reasoning.delta", {
      assistantMessageID: "msg-assistant-1",
      reasoningID: "reason-1",
      delta: "planning next steps",
    })
    child("session.next.tool.called", {
      assistantMessageID: "msg-assistant-1",
      callID: "call-1",
      tool: "bash",
      input: { command: "git status --short" },
      provider: { executed: false },
    })
    reduce(data, {
      type: "permission.v2.asked",
      properties: {
        id: "perm-1",
        sessionID: "child-1",
        action: "bash",
        resources: ["git status --short"],
        source: {
          type: "tool",
          messageID: "msg-assistant-1",
          callID: "call-1",
        },
      },
    })
    child("session.next.text.started", { assistantMessageID: "msg-assistant-1", textID: "txt-1" })
    child("session.next.text.delta", { assistantMessageID: "msg-assistant-1", textID: "txt-1", delta: "hello" })
    child("session.next.text.delta", { assistantMessageID: "msg-assistant-1", textID: "txt-1", delta: " world" })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
    expect(visible(snapshot.details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "$ git status --short",
      "hello world",
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            command: "git status --short",
          },
        },
      }),
    ])
    expect(snapshot.questions).toEqual([])
  })

  test("replays bootstrapped child session messages into inspector commits", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(
      bootstrapSubagentCalls({
        data,
        sessionID: "child-1",
        messages: [
          childMessage({
            messageID: "msg-user-1",
            sessionID: "child-1",
            role: "user",
            parts: [
              {
                id: "txt-user-1",
                messageID: "msg-user-1",
                sessionID: "child-1",
                type: "text",
                text: "Inspect footer tabs",
                time: { start: 1, end: 1 },
              },
            ],
          }),
          childMessage({
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            role: "assistant",
            parts: [
              {
                id: "reason-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "reasoning",
                text: "planning next steps",
                time: { start: 2, end: 2 },
              },
              {
                id: "txt-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "text",
                text: "hello world",
                time: { start: 2, end: 3 },
              },
            ],
          }),
        ],
        thinking: true,
        limits: {},
      }),
    ).toBe(true)

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "hello world",
    ])
  })

  test("marks a running tab cancelled when the child session aborts", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "session.next.step.failed",
      properties: {
        sessionID: "child-1",
        timestamp: 2,
        assistantMessageID: "msg-assistant-1",
        error: { type: "unknown", message: "Provider turn interrupted" },
      },
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        status: "cancelled",
      }),
    ])
  })

  test("links a running task call to the child it spawns, then settles the tab", () => {
    const data = createSubagentData()
    const root = (type: string, properties: Record<string, unknown>) =>
      reduce(data, { type, properties: { sessionID: "parent-1", timestamp: 5, ...properties } })

    root("session.next.tool.called", {
      assistantMessageID: "msg_root",
      callID: "call_task",
      tool: "task",
      input: { description: "Scan reducer paths", subagent_type: "explore", prompt: "scan" },
      provider: { executed: false },
    })
    expect(snapshotSubagentData(data).tabs).toEqual([])

    expect(
      reduce(data, {
        type: "session.next.created",
        properties: { sessionID: "child-9", timestamp: 6, info: { id: "child-9", parentID: "parent-1" } },
      }),
    ).toBe(true)
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-9",
        label: "Explore",
        description: "Scan reducer paths",
        status: "running",
      }),
    ])

    root("session.next.tool.success", {
      assistantMessageID: "msg_root",
      callID: "call_task",
      structured: { sessionID: "child-9", text: "done" },
      content: [{ type: "text", text: "done" }],
      provider: { executed: false },
    })
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-9", status: "completed" }),
    ])
  })

  test("ignores children of other sessions", () => {
    const data = createSubagentData()
    reduce(data, {
      type: "session.next.tool.called",
      properties: {
        sessionID: "parent-1",
        timestamp: 5,
        assistantMessageID: "msg_root",
        callID: "call_task",
        tool: "task",
        input: { description: "x", subagent_type: "explore", prompt: "x" },
        provider: { executed: false },
      },
    })

    expect(
      reduce(data, {
        type: "session.next.created",
        properties: { sessionID: "child-9", timestamp: 6, info: { id: "child-9", parentID: "someone-else" } },
      }),
    ).toBe(false)
    expect(snapshotSubagentData(data).tabs).toEqual([])
  })

  test("pairs a task still running at bootstrap with its unreported child", () => {
    const data = createSubagentData()
    const running = taskMessage("unused", "running")
    const part = running.parts[0]
    if (part?.type !== "tool" || part.state.status !== "running") throw new Error("expected a running task part")

    bootstrapSubagentData({
      data,
      messages: [{ parts: [{ ...part, state: { ...part.state, metadata: {} } }] }],
      children: [{ id: "child-7" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-7", status: "running" }),
    ])
  })

  test("links a child created after bootstrap to a task that was already running", () => {
    const data = createSubagentData()
    const running = taskMessage("unused", "running")
    const part = running.parts[0]
    if (part?.type !== "tool" || part.state.status !== "running") throw new Error("expected a running task part")

    bootstrapSubagentData({
      data,
      messages: [{ parts: [{ ...part, id: "msg-1:call-1", state: { ...part.state, metadata: {} } }] }],
      children: [],
      permissions: [],
      questions: [],
    })
    expect(snapshotSubagentData(data).tabs).toEqual([])

    expect(
      reduce(data, {
        type: "session.next.created",
        properties: { sessionID: "child-8", timestamp: 6, info: { id: "child-8", parentID: "parent-1" } },
      }),
    ).toBe(true)
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-8", status: "running" }),
    ])
  })
})
