import { describe, expect, test } from "bun:test"
import {
  createSessionData,
  flushInterrupted,
  reduceSessionData,
  type SessionDataEvent,
} from "@/cli/cmd/run/session-data"
import type { StreamCommit } from "@/cli/cmd/run/types"

function reduce(data: ReturnType<typeof createSessionData>, event: unknown, thinking = true) {
  return reduceSessionData({
    data,
    event: event as SessionDataEvent,
    sessionID: "session-1",
    thinking,
    limits: {},
  })
}

function assistant(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        ...extra,
      },
    },
  }
}

function user(id: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: {
        id,
        role: "user",
      },
    },
  }
}

function text(input: { id: string; messageID: string; text: string; time?: Record<string, number> }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "text",
        text: input.text,
        ...(input.time ? { time: input.time } : {}),
      },
    },
  }
}

function reasoning(input: { id: string; messageID: string; text: string; time?: Record<string, number> }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "reasoning",
        text: input.text,
        ...(input.time ? { time: input.time } : {}),
      },
    },
  }
}

function delta(messageID: string, partID: string, value: string) {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: "session-1",
      messageID,
      partID,
      field: "text",
      delta: value,
    },
  }
}

function tool(input: { id: string; messageID: string; tool: string; state: Record<string, unknown>; callID?: string }) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.id,
        messageID: input.messageID,
        sessionID: "session-1",
        type: "tool",
        tool: input.tool,
        ...(input.callID ? { callID: input.callID } : {}),
        state: input.state,
      },
    },
  }
}

describe("run session data", () => {
  test("buffers delayed assistant text until the role is known", () => {
    let data = createSessionData()
    data = reduce(data, delta("msg-1", "txt-1", "hello")).data
    data = reduce(data, assistant("msg-1")).data

    const out = reduce(
      data,
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "",
        time: { end: 1 },
      }),
    )

    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "hello",
        partID: "txt-1",
      }),
    ])
  })

  test("keeps leading whitespace buffered until real assistant content arrives", () => {
    let data = createSessionData()
    data = reduce(data, assistant("msg-1")).data
    data = reduce(data, text({ id: "txt-1", messageID: "msg-1", text: "", time: { start: 1 } })).data

    let out = reduce(data, delta("msg-1", "txt-1", " "))
    expect(out.commits).toEqual([])

    out = reduce(out.data, delta("msg-1", "txt-1", "Found"))
    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: " Found",
      }),
    ])
  })

  test("drops delayed text once the message resolves to a user role", () => {
    let data = createSessionData()
    data = reduce(data, text({ id: "txt-user-1", messageID: "msg-user-1", text: "HELLO", time: { end: 1 } })).data

    const out = reduce(data, user("msg-user-1"))

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("txt-user-1")).toBe(true)
  })

  test("suppresses reasoning commits when thinking is disabled", () => {
    const out = reduce(
      createSessionData(),
      reasoning({
        id: "reason-1",
        messageID: "msg-1",
        text: "hidden",
        time: { end: 1 },
      }),
      false,
    )

    expect(out.commits).toEqual([])
    expect(out.data.ids.has("reason-1")).toBe(true)
  })

  test("keeps permission precedence over queued questions", () => {
    let data = createSessionData()
    data = reduce(data, {
      type: "permission.v2.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        action: "read",
        resources: ["/tmp/file.txt"],
      },
    }).data

    const ask = reduce(data, {
      type: "question.v2.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        questions: [
          {
            question: "Mode?",
            header: "Mode",
            options: [{ label: "chunked", description: "Incremental output" }],
            multiSelect: false,
          },
        ],
      },
    })

    expect(ask.footer).toEqual({
      patch: { status: "awaiting permission" },
      view: {
        type: "permission",
        request: expect.objectContaining({ id: "perm-1" }),
      },
    })

    expect(
      reduce(ask.data, {
        type: "permission.v2.replied",
        properties: {
          sessionID: "session-1",
          requestID: "perm-1",
          reply: "reject",
        },
      }).footer,
    ).toEqual({
      patch: { status: "awaiting answer" },
      view: {
        type: "question",
        request: expect.objectContaining({ id: "question-1" }),
      },
    })
  })

  test("refreshes the active permission view when tool input arrives later", () => {
    const data = reduce(createSessionData(), {
      type: "permission.v2.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        action: "bash",
        resources: ["src/**/*.ts"],
        source: {
          type: "tool",
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    }).data

    const out = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: {
            command: "git status --short",
          },
        },
      }),
    )

    expect(out.footer).toEqual({
      view: {
        type: "permission",
        request: expect.objectContaining({
          id: "perm-1",
          metadata: expect.objectContaining({
            input: {
              command: "git status --short",
            },
          }),
        }),
      },
    })
  })

  test("strips bash echo only from the first assistant flush", () => {
    let data = createSessionData()
    data = reduce(data, assistant("msg-1")).data
    data = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "printf hi",
          },
          output: "echoed\n",
          time: { start: 1, end: 2 },
        },
      }),
    ).data

    const first = reduce(
      data,
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "echoed\nanswer",
      }),
    )

    expect(first.commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "answer",
      }),
    ])

    expect(reduce(first.data, delta("msg-1", "txt-1", "\nechoed\nagain")).commits).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "\nechoed\nagain",
      }),
    ])
  })

  test("renders direct shell mode from first-class shell events", () => {
    let data = createSessionData()
    const started = reduce(data, {
      type: "session.next.shell.started",
      properties: {
        sessionID: "session-1",
        timestamp: 1,
        callID: "call-1",
        command: "pwd",
      },
    })

    expect(started.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        phase: "start",
        partID: "shell:call-1",
        tool: "bash",
        shell: {
          callID: "call-1",
          command: "pwd",
        },
      }),
    ])

    data = started.data
    const ended = reduce(data, {
      type: "session.next.shell.ended",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        callID: "call-1",
        output: "/tmp/demo\n",
      },
    })

    expect(ended.commits).toEqual([
      expect.objectContaining({
        kind: "tool",
        phase: "progress",
        partID: "shell:call-1",
        tool: "bash",
        text: "/tmp/demo\n",
        toolState: "completed",
        shell: {
          callID: "call-1",
          command: "pwd",
        },
      }),
    ])
  })

  test("suppresses legacy bash part updates once shell events claim the call", () => {
    let data = reduce(createSessionData(), {
      type: "session.next.shell.started",
      properties: {
        sessionID: "session-1",
        timestamp: 1,
        callID: "call-1",
        command: "pwd",
      },
    }).data

    expect(
      reduce(
        data,
        tool({
          id: "tool-1",
          messageID: "msg-1",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "pwd",
            },
            time: { start: 1 },
          },
        }),
      ).commits,
    ).toEqual([])

    data = reduce(data, {
      type: "session.next.shell.ended",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        callID: "call-1",
        output: "/tmp/demo\n",
      },
    }).data

    expect(
      reduce(
        data,
        tool({
          id: "tool-1",
          messageID: "msg-1",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "pwd",
            },
            output: "/tmp/demo\n",
            title: "",
            metadata: {
              output: "/tmp/demo\n",
            },
            time: { start: 1, end: 2 },
          },
        }),
      ).commits,
    ).toEqual([])
  })

  test("suppresses shell events when the legacy bash part claimed the call first", () => {
    let data = reduce(
      createSessionData(),
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: {
            command: "pwd",
          },
          time: { start: 1 },
        },
      }),
    ).data

    expect(
      reduce(data, {
        type: "session.next.shell.started",
        properties: {
          sessionID: "session-1",
          timestamp: 1,
          callID: "call-1",
          command: "pwd",
        },
      }).commits,
    ).toEqual([])

    data = reduce(
      data,
      tool({
        id: "tool-1",
        messageID: "msg-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "pwd",
          },
          output: "/tmp/demo\n",
          title: "",
          metadata: {
            output: "/tmp/demo\n",
          },
          time: { start: 1, end: 2 },
        },
      }),
    ).data

    expect(
      reduce(data, {
        type: "session.next.shell.ended",
        properties: {
          sessionID: "session-1",
          timestamp: 2,
          callID: "call-1",
          output: "/tmp/demo\n",
        },
      }).commits,
    ).toEqual([])
  })

  test("synthesizes a glob start before an error when the running update is missed", () => {
    expect(
      reduce(
        createSessionData(),
        tool({
          id: "tool-1",
          messageID: "msg-1",
          tool: "glob",
          state: {
            status: "error",
            input: {
              pattern: "**/*tool*",
              path: "/tmp/demo/run",
            },
            error: "No such file or directory: '/tmp/demo/run'",
          },
        }),
      ).commits,
    ).toEqual([
      expect.objectContaining({
        kind: "tool",
        tool: "glob",
        phase: "start",
        partID: "tool-1",
        text: "running glob",
        toolState: "running",
      }),
      expect.objectContaining({
        kind: "tool",
        tool: "glob",
        phase: "final",
        partID: "tool-1",
        text: "No such file or directory: '/tmp/demo/run'",
        toolState: "error",
        toolError: "No such file or directory: '/tmp/demo/run'",
      }),
    ])
  })

  test("flushInterrupted emits one interrupted final per live part", () => {
    const data = reduce(
      createSessionData(),
      text({
        id: "txt-1",
        messageID: "msg-1",
        text: "unfinished",
      }),
    ).data

    const first: StreamCommit[] = []
    flushInterrupted(data, first)
    expect(first).toEqual([
      expect.objectContaining({ kind: "assistant", text: "unfinished", phase: "progress" }),
      expect.objectContaining({ kind: "assistant", phase: "final", interrupted: true }),
    ])

    const next: StreamCommit[] = []
    flushInterrupted(data, next)
    expect(next).toEqual([])
  })

  test("surfaces session failures as error commits", () => {
    const out = reduce(createSessionData(), {
      type: "session.next.failed",
      properties: {
        sessionID: "session-1",
        timestamp: 1,
        error: { type: "unknown", message: "permission denied" },
      },
    })

    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "error",
        text: "permission denied",
      }),
    ])
  })
})

// Live V2 session events, as the server publishes them on the event stream.
function next(type: string, properties: Record<string, unknown>) {
  return { type: `session.next.${type}`, properties: { sessionID: "session-1", timestamp: 10, ...properties } }
}

function step(messageID: string) {
  return next("step.started", {
    assistantMessageID: messageID,
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
  })
}

function run(events: unknown[], thinking = true) {
  let data = createSessionData()
  const commits: StreamCommit[] = []
  const patches: unknown[] = []
  for (const event of events) {
    const out = reduce(data, event, thinking)
    data = out.data
    commits.push(...out.commits)
    if (out.footer?.patch) patches.push(out.footer.patch)
  }
  return { data, commits, patches }
}

describe("run session data (V2 events)", () => {
  test("streams assistant text from text events", () => {
    const out = run([
      step("msg_1"),
      next("text.started", { assistantMessageID: "msg_1", textID: "text-0" }),
      next("text.delta", { assistantMessageID: "msg_1", textID: "text-0", delta: "hello " }),
      next("text.delta", { assistantMessageID: "msg_1", textID: "text-0", delta: "world" }),
      next("text.ended", { assistantMessageID: "msg_1", textID: "text-0", text: "hello world" }),
    ])

    expect(out.commits.map((commit) => [commit.kind, commit.text, commit.partID])).toEqual([
      ["assistant", "hello ", "msg_1:text-0"],
      ["assistant", "world", "msg_1:text-0"],
    ])
    expect(out.patches[0]).toEqual({ status: "assistant responding" })
  })

  test("keeps text ids from different turns apart", () => {
    const turn = (messageID: string, value: string) => [
      step(messageID),
      next("text.started", { assistantMessageID: messageID, textID: "text-0" }),
      next("text.ended", { assistantMessageID: messageID, textID: "text-0", text: value }),
    ]
    const out = run([...turn("msg_1", "first"), ...turn("msg_2", "second")])

    expect(out.commits.map((commit) => commit.text)).toEqual(["first", "second"])
  })

  test("flushes text when the stream is joined after the step started", () => {
    const out = run([
      next("text.delta", { assistantMessageID: "msg_1", textID: "text-0", delta: "late" }),
      next("text.ended", { assistantMessageID: "msg_1", textID: "text-0", text: "late join" }),
    ])

    expect(out.commits.map((commit) => commit.text).join("")).toBe("late join")
  })

  test("hides reasoning when thinking is off", () => {
    const events = [
      step("msg_1"),
      next("reasoning.started", { assistantMessageID: "msg_1", reasoningID: "r-0" }),
      next("reasoning.delta", { assistantMessageID: "msg_1", reasoningID: "r-0", delta: "pondering" }),
      next("reasoning.ended", { assistantMessageID: "msg_1", reasoningID: "r-0", text: "pondering" }),
    ]

    expect(run(events, false).commits).toEqual([])
    expect(run(events, true).commits.map((commit) => [commit.kind, commit.text])).toEqual([
      ["reasoning", "Thinking: pondering"],
    ])
  })

  test("renders a bash call from called to success without the model status line", () => {
    const out = run([
      step("msg_1"),
      next("tool.input.started", { assistantMessageID: "msg_1", callID: "call_1", name: "bash" }),
      next("tool.called", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        tool: "bash",
        input: { command: "python3 -", stdin: "print(1)\nprint(2)\n" },
        provider: { executed: false },
      }),
      next("tool.success", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        structured: { exit: 0, truncated: false },
        content: [
          { type: "text", text: "1\n2\n" },
          { type: "text", text: "[exit code 0]" },
        ],
        provider: { executed: false },
      }),
    ])

    expect(out.commits.map((commit) => [commit.phase, commit.toolState, commit.text])).toEqual([
      ["start", "running", "running bash"],
      ["progress", "completed", "1\n2\n"],
    ])
    const part = out.commits[1]?.part
    expect(part?.id).toBe("msg_1:call_1")
    expect(part?.callID).toBe("call_1")
    expect(part?.state.status === "completed" && part.state.metadata.exit).toBe(0)
    expect(part?.state.input).toEqual({ command: "python3 -", stdin: "print(1)\nprint(2)\n" })
  })

  test("maps V2 edit output onto the diff the renderer reads", () => {
    const out = run([
      step("msg_1"),
      next("tool.called", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        tool: "edit",
        input: { path: "src/a.ts", oldString: "a", newString: "b" },
        provider: { executed: false },
      }),
      next("tool.success", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        structured: { files: [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" }], replacements: 1 },
        content: [{ type: "text", text: "Edit applied successfully." }],
        provider: { executed: false },
      }),
    ])

    const final = out.commits.find((commit) => commit.phase === "final")
    expect(final?.part?.state.input).toMatchObject({ filePath: "src/a.ts" })
    expect(final?.part?.state.status === "completed" && final.part.state.metadata.diff).toBe("@@ -1 +1 @@\n-a\n+b\n")
  })

  test("fails a tool call with the error message", () => {
    const out = run([
      step("msg_1"),
      next("tool.called", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        tool: "glob",
        input: { pattern: "*.ts" },
        provider: { executed: false },
      }),
      next("tool.failed", {
        assistantMessageID: "msg_1",
        callID: "call_1",
        error: { type: "unknown", message: "no such directory" },
        provider: { executed: false },
      }),
    ])

    expect(out.commits.at(-1)).toMatchObject({
      kind: "tool",
      phase: "final",
      toolState: "error",
      toolError: "no such directory",
      tool: "glob",
    })
  })

  test("reports usage when a step ends and errors when it fails", () => {
    const ended = run([
      step("msg_1"),
      next("step.ended", {
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input: 1200, output: 34, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ])
    expect(ended.patches.at(-1)).toEqual({ usage: "1.2K" })

    const failed = run([
      step("msg_1"),
      next("step.failed", { assistantMessageID: "msg_1", error: { type: "unknown", message: "rate limited" } }),
    ])
    expect(failed.commits).toEqual([expect.objectContaining({ kind: "error", text: "rate limited" })])

    const interrupted = run([
      step("msg_1"),
      next("step.failed", {
        assistantMessageID: "msg_1",
        error: { type: "unknown", message: "Provider turn interrupted" },
      }),
    ])
    expect(interrupted.commits).toEqual([])
  })

  test("shows a retry on the open turn until the next step", () => {
    const out = run([
      step("msg_1"),
      next("retried", { attempt: 2, error: { message: "overloaded", isRetryable: true } }),
      step("msg_2"),
    ])

    expect(out.patches).toEqual([
      { status: "assistant responding" },
      { status: "retrying (attempt 2): overloaded" },
      { status: "assistant responding" },
    ])
    expect(out.data.retrying).toBe(false)
  })

  test("points a legacy session failure at the backfill command", () => {
    const out = run([
      next("failed", {
        error: { type: "unknown", message: "Session history is not migrated" },
        name: "Session.LegacyNotMigratedError",
      }),
    ])

    expect(out.commits[0]?.text).toContain("miao db backfill")
  })

  test("marks compaction in the status and the transcript", () => {
    const out = run([
      next("compaction.started", { messageID: "msg_c", reason: "auto" }),
      next("compaction.ended", { messageID: "msg_c", reason: "auto", text: "summary", recent: "" }),
    ])

    expect(out.patches).toEqual([{ status: "compacting context" }])
    expect(out.commits).toEqual([
      expect.objectContaining({ kind: "system", text: "context compacted (auto)", messageID: "msg_c" }),
    ])
  })

  test("drops a recovered question once its tool call settles", () => {
    const out = run([
      step("msg_1"),
      next("tool.called", {
        assistantMessageID: "msg_1",
        callID: "call_q",
        tool: "question",
        input: { questions: [{ question: "Mode?", header: "Mode", options: [] }] },
        provider: { executed: false },
      }),
      {
        type: "question.v2.asked",
        properties: {
          id: "que_1",
          sessionID: "session-1",
          questions: [{ question: "Mode?", header: "Mode", options: [] }],
          tool: { messageID: "msg_1", callID: "call_q" },
        },
      },
      next("tool.success", {
        assistantMessageID: "msg_1",
        callID: "call_q",
        structured: { answers: [["fast"]] },
        content: [{ type: "text", text: "answered" }],
        provider: { executed: false },
      }),
    ])

    expect(out.data.questions).toEqual([])
  })

  test("ignores events for other sessions", () => {
    const out = run([
      { ...step("msg_1"), properties: { ...step("msg_1").properties, sessionID: "session-2" } },
      {
        type: "permission.v2.asked",
        properties: { id: "per_2", sessionID: "session-2", action: "bash", resources: ["ls"] },
      },
    ])

    expect(out.commits).toEqual([])
    expect(out.data.permissions).toEqual([])
  })
})
