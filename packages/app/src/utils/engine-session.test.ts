import { describe, expect, test } from "bun:test"
import {
  EngineSessionShapeError,
  catalogRowToSummary,
  catalogToSummaries,
  snapshotToState,
  type EngineCatalogRow,
} from "./engine-session"

// Captured verbatim from `session_catalog` on `miao serve` built from this tree,
// so the fixtures fail as soon as the engine's row shape changes.
const live: EngineCatalogRow = {
  account_selection: null,
  archived_at_ms: null,
  location: "/private/tmp/ws2",
  model_selection: null,
  parent_session_id: null,
  pinned_at_ms: null,
  preview: null,
  session_id: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  title: "Catalog probe",
  updated_at_ms: 1794232836295,
}

const older: EngineCatalogRow = {
  session_id: "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "Older",
  updated_at_ms: 1794232800000,
}

const archived: EngineCatalogRow = {
  session_id: "ses_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  title: "Archived",
  updated_at_ms: 1794232900000,
  archived_at_ms: 1794232900001,
}

describe("catalogRowToSummary", () => {
  test("maps a live engine row without losing identity or timing", () => {
    expect(catalogRowToSummary(live)).toEqual({
      id: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Catalog probe",
      updatedAt: 1794232836295,
      pinned: false,
      archived: false,
    })
  })

  test("carries lineage, preview and pin state when the engine has them", () => {
    const row: EngineCatalogRow = {
      ...live,
      parent_session_id: "ses_parent",
      pinned_at_ms: 1794232836300,
      preview: "last message",
    }
    expect(catalogRowToSummary(row)).toMatchObject({
      parentID: "ses_parent",
      pinned: true,
      preview: "last message",
    })
  })

  test("treats a session without timing as the oldest, not as an invalid row", () => {
    expect(catalogRowToSummary({ session_id: "s", title: "t" }).updatedAt).toBe(0)
  })

  test("fails on a row that has no usable identity or title", () => {
    expect(() => catalogRowToSummary({ title: "t" })).toThrow(EngineSessionShapeError)
    expect(() => catalogRowToSummary({ session_id: "s" })).toThrow(EngineSessionShapeError)
    try {
      catalogRowToSummary({ session_id: 7, title: "t" })
    } catch (error) {
      expect((error as EngineSessionShapeError).field).toBe("session_id")
    }
  })
})

describe("catalogToSummaries", () => {
  test("orders newest first and hides archived rows by default", () => {
    expect(catalogToSummaries([older, archived, live]).map((session) => session.title)).toEqual([
      "Catalog probe",
      "Older",
    ])
  })

  test("keeps archived rows on request", () => {
    expect(catalogToSummaries([older, archived, live], { includeArchived: true }).map((s) => s.title)).toEqual([
      "Archived",
      "Catalog probe",
      "Older",
    ])
  })
})

// Captured verbatim from `snapshot` on the same engine build.
const liveSnapshot = {
  account_selection: null,
  active_run: null,
  agent: null,
  approvals: [],
  archived_at_ms: null,
  context: null,
  created_at_ms: 1794232836295,
  crons: [],
  cursor: 1,
  event_base: 0,
  has_messages: false,
  location: "/private/tmp/ws2",
  message_count: 0,
  messages: [],
  mode: "build",
  model_selection: null,
  parent_session_id: null,
  pending: [],
  pinned_at_ms: null,
  preview: null,
  questions: [],
  reverted_count: 0,
  selection: null,
  session_id: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  staged_revert: null,
  state: { goal: null, todos: null },
  tag: "",
  title: "Catalog probe",
  transfer_import: null,
  updated_at_ms: 1794232836295,
  wakeups: [],
}

describe("snapshotToState", () => {
  test("reads the header of a live snapshot", () => {
    expect(snapshotToState(liveSnapshot)).toEqual({
      id: "ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Catalog probe",
      cursor: 1,
      messageCount: 0,
      hasMessages: false,
      pending: 0,
      approvals: 0,
    })
  })

  test("counts pending inputs and approvals, and does not invent a cursor", () => {
    expect(
      snapshotToState({ ...liveSnapshot, pending: [{}, {}], approvals: [{}], cursor: undefined }),
    ).toMatchObject({ pending: 2, approvals: 1, cursor: 0 })
  })

  test("fails when the snapshot cannot name its Session", () => {
    expect(() => snapshotToState({ title: "t" })).toThrow(EngineSessionShapeError)
  })
})
