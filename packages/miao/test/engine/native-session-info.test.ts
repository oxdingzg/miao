import { expect, test } from "bun:test"
import { SessionID } from "@miao/schema/session-id"
import { Location } from "@miao/schema/location"
import { Project } from "@miao/schema/project"
import { DateTime, Schema } from "effect"
import { nativeSessionInfo } from "@miao/server/native-session"

const sessionID = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionID")))("ses_native") as never
const projectID = Schema.decodeUnknownSync(Project.ID)("prj_one")
const location = Schema.decodeUnknownSync(Location.Ref)({ directory: "/workspace" })

test("engine snapshot projects to the product record without inventing facts", () => {
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: {
      session_id: "ses_native",
      title: "First title",
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_001_000,
    },
  })
  expect(info.id).toBe(sessionID)
  expect(info.projectID).toBe(projectID)
  expect(info.title).toBe("First title")
  expect(info.location).toEqual(location)
  expect(info.cost).toBe(0)
  expect(info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  expect(DateTime.toEpochMillis(info.time.created)).toBe(1_700_000_000_000)
  expect(DateTime.toEpochMillis(info.time.updated)).toBe(1_700_000_001_000)
  // The engine knows collaboration mode, not product identities.
  expect(info.agent).toBeUndefined()
  expect(info.model).toBeUndefined()
})

test("unknown metadata degrades honestly instead of fabricating", () => {
  const info = nativeSessionInfo({
    sessionID,
    projectID,
    location,
    snapshot: { session_id: "ses_native", title: null, created_at_ms: null, updated_at_ms: null },
  })
  expect(info.title).toBe("")
  expect(DateTime.toEpochMillis(info.time.created)).toBe(0)
  expect(DateTime.toEpochMillis(info.time.updated)).toBe(0)
})

test("fork lineage comes from the engine snapshot rather than a fabricated catalog parent", () => {
  const input = { sessionID: SessionID.make("ses_child"), projectID, location }
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: "ses_parent" } }).parentID).toBe(SessionID.make("ses_parent"))
  expect(nativeSessionInfo({ ...input, snapshot: { parent_session_id: null } }).parentID).toBeUndefined()
  expect(() => nativeSessionInfo({ ...input, snapshot: { parent_session_id: "invalid" } })).toThrow()
})
