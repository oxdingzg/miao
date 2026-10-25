import { expect, test } from "bun:test"
import { translatePrompt } from "@/engine/bridge"
import { generatedInputMessageID } from "@/engine/identity"
import { cancelPendingInput, pendingInputsPage } from "@/engine/native-engine"
import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"
import { DateTime } from "effect"

test("an engine inbox page becomes admitted receipts with their attachments", () => {
  const page = pendingInputsPage(SessionID.make("ses_inbox"), {
    inputs: [
      {
        id: "msg_one",
        session_id: "ses_inbox",
        prompt: "first",
        delivery: "queue",
        admitted_seq: 4,
        recorded_at_ms: 1_700_000_000_000,
        attachments: [],
      },
      {
        id: "msg_two",
        session_id: "ses_inbox",
        prompt: "second",
        delivery: "steer",
        admitted_seq: 7,
        recorded_at_ms: 1_700_000_000_500,
        attachments: [{ mime: "image/png", data: "aGVsbG8=", metadata: { name: "shot.png", path: "/tmp/shot.png" } }],
      },
    ],
    has_more: true,
  })
  expect(page.hasMore).toBe(true)
  expect(page.inputs.map((input) => String(input.id))).toEqual(["msg_one", "msg_two"])
  expect(String(page.inputs[0]?.sessionID)).toBe("ses_inbox")
  expect(page.inputs[0]?.prompt).toEqual({ text: "first" })
  expect(page.inputs[0]?.delivery).toBe("queue")
  expect(page.inputs[0]?.admittedSeq).toBe(4)
  expect(DateTime.toEpochMillis(page.inputs[0]!.timeCreated)).toBe(1_700_000_000_000)
  expect(page.inputs[1]?.prompt).toEqual({
    text: "second",
    files: [
      {
        uri: "data:image/png;base64,aGVsbG8=",
        mime: "image/png",
        name: "shot.png",
        path: "/tmp/shot.png",
      },
    ],
  })
  expect(page.inputs[1]?.promotedSeq).toBeUndefined()
})

test("an empty inbox stays empty", () => {
  const page = pendingInputsPage(SessionID.make("ses_inbox"), { inputs: [], has_more: false })
  expect(page.inputs).toEqual([])
  expect(page.hasMore).toBe(false)
})

test("engine-generated inputs get a product identity instead of failing the page", () => {
  const page = pendingInputsPage(SessionID.make("ses_inbox"), {
    inputs: [
      {
        id: "monitor:8ffca768-5f2a-4cea-a62a-1d1688529fdf:d3a3e670-4240-472b-8fb7-ca5672ea0f2c",
        session_id: "ses_inbox",
        prompt: "Monitor job produced matching output",
        delivery: "steer",
        admitted_seq: 9,
        recorded_at_ms: 1_700_000_000_000,
        attachments: [],
      },
      {
        id: "wakeup/sched_1",
        session_id: "ses_inbox",
        prompt: "scheduled wakeup",
        delivery: "queue",
        admitted_seq: 11,
        recorded_at_ms: 1_700_000_000_500,
        attachments: [],
      },
    ],
    has_more: false,
  })
  // The id derives from the engine's durable input id, not from the admission
  // sequence, so the promotion event (which carries the same input id) can
  // project the same identity and a later cancel can decode it back.
  expect(page.inputs.map((input) => String(input.id))).toEqual([
    "msg_gen_bW9uaXRvcjo4ZmZjYTc2OC01ZjJhLTRjZWEtYTYyYS0xZDE2ODg1MjlmZGY6ZDNhM2U2NzAtNDI0MC00NzJiLThmYjctY2E1NjcyZWEwZjJj",
    "msg_gen_d2FrZXVwL3NjaGVkXzE",
  ])
})

test("an engine-generated notice reads and promotes under one identity", () => {
  const engineInputID = "monitor:8ffca768-5f2a-4cea-a62a-1d1688529fdf:d3a3e670-4240-472b-8fb7-ca5672ea0f2c"
  const page = pendingInputsPage(SessionID.make("ses_inbox"), {
    inputs: [
      {
        id: engineInputID,
        session_id: "ses_inbox",
        prompt: "Monitor job produced matching output",
        delivery: "steer",
        admitted_seq: 9,
        recorded_at_ms: 1_700_000_000_000,
        attachments: [],
      },
    ],
    has_more: false,
  })
  // The promotion lands at a later journal seq than admission; the identity
  // must not follow the seq or the read and the promoted message disagree.
  const promoted = translatePrompt({
    session_id: "ses_inbox",
    seq: 12,
    kind: "input.promoted",
    data: { input_id: engineInputID, prompt: "Monitor job produced matching output" },
  })
  expect(String(page.inputs[0]?.id)).toBe(String(promoted?.messageID))
})

test("a generated notice is cancelled by resolving its engine identity once", async () => {
  const calls: string[] = []
  const accepted = await cancelPendingInput(async (inputID) => {
    calls.push(inputID)
    return inputID.startsWith("msg_gen_") ? { accepted: false, reason: "unknown" } : { accepted: true }
  }, generatedInputMessageID("monitor:job:u"))
  expect(accepted).toBe(true)
  expect(calls).toEqual([String(generatedInputMessageID("monitor:job:u")), "monitor:job:u"])
})

test("a submitted prompt cancels under its own identity", async () => {
  const calls: string[] = []
  const accepted = await cancelPendingInput(async (inputID) => {
    calls.push(inputID)
    return { accepted: true, duplicate: true }
  }, SessionMessage.ID.make("msg_submitted"))
  expect(accepted).toBe(true)
  expect(calls).toEqual(["msg_submitted"])
})

test("a promoted notice keeps its final answer instead of resolving elsewhere", async () => {
  const calls: string[] = []
  const accepted = await cancelPendingInput(async (inputID) => {
    calls.push(inputID)
    return { accepted: false, reason: "promoted" }
  }, generatedInputMessageID("monitor:job:u"))
  expect(accepted).toBe(false)
  expect(calls).toEqual([String(generatedInputMessageID("monitor:job:u"))])
})

test("a generated identity the engine cannot resolve reports false", async () => {
  const calls: string[] = []
  const accepted = await cancelPendingInput(async (inputID) => {
    calls.push(inputID)
    return { accepted: false, reason: "unknown" }
  }, generatedInputMessageID("monitor:missing"))
  expect(accepted).toBe(false)
  expect(calls).toEqual([String(generatedInputMessageID("monitor:missing")), "monitor:missing"])
})

test("an engine input needs a non-empty identity", () => {
  expect(() =>
    pendingInputsPage(SessionID.make("ses_inbox"), {
      inputs: [
        {
          id: "",
          session_id: "ses_inbox",
          prompt: "missing identity",
          delivery: "steer",
          admitted_seq: 1,
          recorded_at_ms: 1_700_000_000_000,
          attachments: [],
        },
      ],
      has_more: false,
    }),
  ).toThrow()
})
