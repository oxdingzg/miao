import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { selectNativeSessions } from "@miao/server/native-session"
import { SessionID } from "@miao/schema/session-id"
import type { SessionInfo } from "@miao/schema/session-info"

const id = (value: string) => Schema.decodeUnknownSync(SessionID)(value)

const session = (value: string, created: number, title = ""): SessionInfo.Info =>
  ({
    id: id(value),
    projectID: "prj_one",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(created), updated: DateTime.makeUnsafe(created) },
    title,
    location: { directory: "/workspace" },
  }) as SessionInfo.Info

const page = [
  session("ses_a", 300, "alpha"),
  session("ses_b", 200, "beta"),
  session("ses_c", 200, "gamma"),
]

test("native sessions page on the catalog key in both orders", () => {
  expect(selectNativeSessions({ sessions: page, order: "desc", limit: 2 }).map((s) => s.id)).toEqual([id("ses_a"), id("ses_c")])
  expect(selectNativeSessions({ sessions: page, order: "asc", limit: 2 }).map((s) => s.id)).toEqual([id("ses_b"), id("ses_c")])
})

test("native sessions respect the anchor predicate and search", () => {
  // Next page after ses_a (created 300): strictly older entries.
  expect(
    selectNativeSessions({ sessions: page, order: "desc", anchor: { id: id("ses_a"), time: 300 }, limit: 5 }).map((s) => s.id),
  ).toEqual([id("ses_c"), id("ses_b")])
  // Same timestamp: the id breaks the tie exactly like the catalog.
  expect(
    selectNativeSessions({ sessions: page, order: "desc", anchor: { id: id("ses_c"), time: 200 }, limit: 5 }).map((s) => s.id),
  ).toEqual([id("ses_b")])
  expect(selectNativeSessions({ sessions: page, order: "desc", search: "amma", limit: 5 }).map((s) => s.id)).toEqual([id("ses_c")])
})
