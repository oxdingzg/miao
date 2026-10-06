import { expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessage } from "@miao/schema/view-models"
import {
  isLiveSessionV2Event,
  isSessionListV2Event,
  isV2StreamFragmentEvent,
  mergeTranscript,
} from "../src/context/session-v2"
import { promptInputFromParts } from "../src/context/session-v2-write"

const base = { sessionID: "ses_1" }

test("merges the active context with the older projected timeline", () => {
  const user = (id: string, created: number, text: string): SessionMessage => ({
    id,
    type: "user",
    time: { created },
    text,
  })
  const active = [user("msg_3", 30, "after compaction")]
  const history = [
    user("msg_2", 20, "pruned copy"),
    user("msg_3", 30, "stale copy"),
    user("msg_1", 10, "before compaction"),
  ]
  const merged = mergeTranscript(active, history)
  expect(merged.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"])
  expect(merged.find((message) => message.id === "msg_3")).toMatchObject({ text: "after compaction" })
})

test("classifies live V2 session events for transcript refresh", () => {
  expect(isLiveSessionV2Event("session.next.text.delta")).toBe(true)
  expect(isLiveSessionV2Event("session.next.step.ended")).toBe(true)
  expect(isLiveSessionV2Event("session.next.moved")).toBe(false)
  expect(isLiveSessionV2Event("session.next.status")).toBe(false)
  expect(isLiveSessionV2Event("session.next.retried")).toBe(false)
  expect(isLiveSessionV2Event("message.part.updated")).toBe(false)
})

test("applies stream fragments incrementally instead of re-hydrating", () => {
  expect(isV2StreamFragmentEvent("session.next.text.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.reasoning.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.tool.input.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.tool.progress")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.text.ended")).toBe(false)
  expect(isV2StreamFragmentEvent("session.next.tool.called")).toBe(false)
  expect(isV2StreamFragmentEvent("session.next.step.ended")).toBe(false)
})

test("classifies list-only events that must not hydrate an unopened session", () => {
  expect(isSessionListV2Event("session.next.created")).toBe(true)
  expect(isSessionListV2Event("session.next.info.updated")).toBe(true)
  expect(isSessionListV2Event("session.next.text.delta")).toBe(false)
  expect(isSessionListV2Event("session.next.step.started")).toBe(false)
  expect(isSessionListV2Event("session.next.compaction.ended")).toBe(false)
})

test("maps prompt parts into the V2 prompt input", () => {
  expect(promptInputFromParts([{ type: "text", text: "hi" }])).toEqual({ text: "hi" })
  expect(
    promptInputFromParts([
      { type: "text", text: "hi" },
      { type: "file", url: "file:///a.png", filename: "a.png" },
    ]),
  ).toEqual({ text: "hi", files: [{ uri: "file:///a.png", name: "a.png" }] })
  const pdf = "data:application/pdf;base64,JVBERi0="
  const local = path.resolve("report.pdf")
  expect(
    promptInputFromParts([
      { type: "text", text: "[PDF 1]" },
      { type: "file", url: pdf, filename: "report.pdf", source: { type: "file", path: local } },
      // A clipboard paste has no file on disk; its source path falls back to the bare filename.
      { type: "file", url: pdf, filename: "clip.pdf", source: { type: "file", path: "clip.pdf" } },
    ]),
  ).toEqual({
    text: "[PDF 1]",
    files: [
      { uri: pdf, name: "report.pdf", path: local },
      { uri: pdf, name: "clip.pdf" },
    ],
  })
  expect(
    promptInputFromParts([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
  ).toEqual({ text: "a\n\nb" })
})

