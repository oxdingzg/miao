import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { mergeListingPage, selectNativeSessions } from "@miao/server/native-session"
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

const page = [session("ses_a", 300, "alpha"), session("ses_b", 200, "beta"), session("ses_c", 200, "gamma")]

test("native sessions page on the catalog key in both orders", () => {
  expect(selectNativeSessions({ sessions: page, order: "desc", limit: 2 }).map((s) => s.id)).toEqual([
    id("ses_a"),
    id("ses_c"),
  ])
  expect(selectNativeSessions({ sessions: page, order: "asc", limit: 2 }).map((s) => s.id)).toEqual([
    id("ses_b"),
    id("ses_c"),
  ])
})

test("native sessions respect the anchor predicate and search", () => {
  // Next page after ses_a (created 300): strictly older entries.
  expect(
    selectNativeSessions({ sessions: page, order: "desc", anchor: { id: id("ses_a"), time: 300 }, limit: 5 }).map(
      (s) => s.id,
    ),
  ).toEqual([id("ses_c"), id("ses_b")])
  // Same timestamp: the id breaks the tie exactly like the catalog.
  expect(
    selectNativeSessions({ sessions: page, order: "desc", anchor: { id: id("ses_c"), time: 200 }, limit: 5 }).map(
      (s) => s.id,
    ),
  ).toEqual([id("ses_b")])
  expect(selectNativeSessions({ sessions: page, order: "desc", search: "amma", limit: 5 }).map((s) => s.id)).toEqual([
    id("ses_c"),
  ])
})

test("anchored previous pages flip the traversal and restore the requested order", () => {
  // desc full order is [ses_a(300), ses_c(200), ses_b(200)]; the page-1 tail
  // anchor (ses_b, 200) must page the strictly newer side in asc traversal,
  // where ses_c (same time, larger id) is the adjacent element.
  expect(
    selectNativeSessions({
      sessions: page,
      order: "desc",
      anchor: { id: id("ses_b"), time: 200, direction: "previous" },
      limit: 1,
    }).map((s) => s.id),
  ).toEqual([id("ses_c")])
  // Nothing newer than the newest element: an empty previous page.
  expect(
    selectNativeSessions({
      sessions: page,
      order: "desc",
      anchor: { id: id("ses_a"), time: 300, direction: "previous" },
      limit: 5,
    }).map((s) => s.id),
  ).toEqual([])
})

test("anchored paging mirrors the catalog in ascending order too", () => {
  expect(
    selectNativeSessions({
      sessions: page,
      order: "asc",
      anchor: { id: id("ses_b"), time: 200, direction: "next" },
      limit: 5,
    }).map((s) => s.id),
  ).toEqual([id("ses_c"), id("ses_a")])
  expect(
    selectNativeSessions({
      sessions: page,
      order: "asc",
      anchor: { id: id("ses_a"), time: 300, direction: "previous" },
      limit: 1,
    }).map((s) => s.id),
  ).toEqual([id("ses_c")])
})

test("merge excludes native-owned catalog rows even if native projection is outside this page", () => {
  const authoritative = session("ses_a", 150, "engine title")
  const merged = mergeListingPage({
    sessions: [...page, page[1]],
    native: [authoritative],
    nativeIDs: new Set([id("ses_a")]),
    order: "desc",
    limit: 5,
  })
  expect(merged.map((session) => session.id)).toEqual([id("ses_c"), id("ses_b"), id("ses_a")])
  expect(merged.find((session) => session.id === id("ses_a"))?.title).toBe("engine title")
  expect(
    mergeListingPage({ sessions: page, native: [], nativeIDs: new Set([id("ses_a")]), order: "desc", limit: 5 }).map(
      (session) => session.id,
    ),
  ).toEqual([id("ses_c"), id("ses_b")])
})

test("previous merged pages take nearest entries across both sources before restoring order", () => {
  const merged = mergeListingPage({
    sessions: [session("ses_far", 500, "far"), session("ses_near", 300, "near")],
    native: [session("ses_native", 250, "nearest")],
    nativeIDs: new Set([id("ses_native")]),
    order: "desc",
    direction: "previous",
    limit: 2,
  })
  expect(merged.map((session) => session.id)).toEqual([id("ses_near"), id("ses_native")])
})
