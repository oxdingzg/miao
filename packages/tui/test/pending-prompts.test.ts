import type { Message } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import type { PendingPrompt } from "../src/context/pending-prompts"
import { createPendingPrompts } from "../src/context/pending-prompts"

function prompt(id: string, sessionID = "ses_test"): PendingPrompt {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      time: { created: 10 },
    },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text: "new question" }],
    state: "sending",
    delivery: "steer",
  }
}

test("local receipts are visible immediately without becoming projected history", () => {
  const receipts = createPendingPrompts()
  const projected: Message[] = []
  receipts.add(prompt("msg_one"))
  expect(receipts.messages("ses_test", projected)).toHaveLength(1)
  expect(projected).toHaveLength(0)
  expect(receipts.data.msg_one.state).toBe("sending")
  receipts.admit("msg_one")
  expect(receipts.data.msg_one.state).toBe("admitted")
  expect(receipts.messages("ses_test", projected)).toHaveLength(1)
})

test("hydration retains unpromoted receipts and reconciles promoted IDs exactly once", () => {
  const receipts = createPendingPrompts()
  const first = prompt("msg_one")
  receipts.add(first)
  receipts.add(prompt("msg_two"))
  receipts.reconcile("ses_test", [])
  expect(receipts.messages("ses_test", [])).toHaveLength(2)
  expect(receipts.messages("ses_test", [first.info])).toHaveLength(2)
  receipts.reconcile("ses_test", [first.info])
  expect(receipts.data.msg_one).toBeUndefined()
  expect(receipts.data.msg_two).toBeDefined()
  expect(receipts.messages("ses_test", [first.info])).toHaveLength(2)
})

test("failed sends retain their text and an authoritative admission can recover them", () => {
  const receipts = createPendingPrompts()
  receipts.add(prompt("msg_one"))
  receipts.fail("msg_one", "offline")
  expect(receipts.data.msg_one.state).toBe("failed")
  expect(receipts.data.msg_one.parts[0]).toMatchObject({ text: "new question" })
  receipts.admit("msg_one")
  expect(receipts.data.msg_one.state).toBe("admitted")
  expect(receipts.data.msg_one.error).toBeUndefined()
  receipts.fail("msg_one", "late network failure")
  expect(receipts.data.msg_one.state).toBe("admitted")
})

test("duplicate admissions and late callbacks cannot resurrect promoted receipts", () => {
  const receipts = createPendingPrompts()
  receipts.add(prompt("msg_one"))
  receipts.admit("msg_one")
  receipts.add(prompt("msg_one"))
  expect(receipts.data.msg_one.state).toBe("admitted")
  receipts.remove("msg_one")
  receipts.admit("msg_one")
  receipts.fail("msg_one", "late failure")
  expect(receipts.messages("ses_test", [])).toEqual([])
})

test("sessions have independent receipts and clearing one does not clear another", () => {
  const receipts = createPendingPrompts()
  receipts.add(prompt("msg_one"))
  receipts.add(prompt("msg_other", "ses_other"))
  expect(receipts.messages("ses_test", []).map((message) => message.id)).toEqual(["msg_one"])
  receipts.reconcile("ses_test", [receipts.data.msg_other.info])
  expect(receipts.data.msg_other).toBeDefined()
  receipts.clear("ses_test")
  expect(receipts.data.msg_one).toBeUndefined()
  expect(receipts.messages("ses_other", []).map((message) => message.id)).toEqual(["msg_other"])
})

test("unpromoted receipts stay at the transcript tail when the client clock trails", () => {
  const receipts = createPendingPrompts()
  // Local receipt stamps 10; projected history is already past it (20).
  receipts.add(prompt("msg_local"))
  const projected = [
    {
      id: "msg_server",
      sessionID: "ses_test",
      role: "user",
      time: { created: 20 },
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    },
  ] as Message[]

  expect(receipts.messages("ses_test", projected).map((message) => message.id)).toEqual(["msg_server", "msg_local"])
})
