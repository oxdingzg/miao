import { expect, test } from "bun:test"
import { createTuiV2SessionReducer } from "../../../../src/context/session-v2-reducer"

const stamp = { sessionID: "ses_command", timestamp: 1 }

test("command receipts update the promoted user message without adding duplicate prompts", () => {
  const reducer = createTuiV2SessionReducer()
  const promoted = reducer.reduce([], {
    type: "session.next.prompted",
    properties: {
      ...stamp,
      messageID: "msg_command",
      delivery: "steer",
      prompt: { text: "raw", command: { name: "daily", arguments: "", subtask: false } },
    },
  })
  const started = reducer.reduce(promoted?.messages ?? [], {
    type: "session.next.command.started",
    properties: { ...stamp, messageID: "msg_command" },
  })
  expect(started?.messages[0]).toMatchObject({ commandState: "running" })
  const completed = reducer.reduce(started?.messages ?? [], {
    type: "session.next.command.completed",
    properties: { ...stamp, messageID: "msg_command", prompt: { text: "expanded" } },
  })
  expect(completed?.messages).toHaveLength(1)
  expect(completed?.touched).toEqual(["msg_command"])
  expect(completed?.messages[0]).toMatchObject({ text: "expanded", commandState: "completed" })
  const failed = reducer.reduce(started?.messages ?? [], {
    type: "session.next.command.failed",
    properties: { ...stamp, messageID: "msg_command", error: "refused", text: "canonical failure" },
  })
  expect(failed?.messages[0]).toMatchObject({
    text: "canonical failure",
    commandError: "refused",
    commandState: "failed",
  })
})
