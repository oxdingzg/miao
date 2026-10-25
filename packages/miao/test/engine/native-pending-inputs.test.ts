import { expect, test } from "bun:test"
import { pendingInputsPage } from "@/engine/native-engine"
import { SessionID } from "@miao/schema/session-id"
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
