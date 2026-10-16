import { Project } from "@miao/schema/project"
import type { AbsolutePath } from "@miao/schema/schema"
import type { Location } from "@miao/schema/location"
import { SessionInfo } from "@miao/schema/session-info"
import { SessionID } from "@miao/schema/session-id"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@miao/core/database/database"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { NativeEngine } from "./native-engine"

/**
 * Project the engine-owned Session snapshot into the product record the HTTP
 * API serves. Native Sessions are stored by the engine, so its snapshot is the
 * authority for identity, title, and time; the caller supplies the resolved
 * project and Location because those are placement facts, not engine facts.
 *
 * Honesty rules, matching the agreed conventions: `cost` stays 0 (pricing is
 * a product catalog the engine does not own), `tokens` are 0 until the engine
 * reports usage, `agent`/`model` stay unknown (the engine knows collaboration
 * mode, not product identities), and a missing creation time renders as epoch
 * only for Sessions that predate the metadata column.
 */
export function nativeSessionInfo(input: {
  sessionID: SessionID
  projectID: Project.ID
  location: Location.Ref
  snapshot: Readonly<Record<string, unknown>>
}): SessionInfo.Info {
  const created = number(input.snapshot["created_at_ms"])
  const updated = number(input.snapshot["updated_at_ms"])
  const title = input.snapshot["title"]
  return {
    id: input.sessionID,
    ...(typeof input.snapshot["parent_session_id"] === "string"
      ? { parentID: Schema.decodeUnknownSync(SessionID)(input.snapshot["parent_session_id"]) }
      : {}),
    projectID: input.projectID,
    execution: { engine: "rust", selection: "operator" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: DateTime.makeUnsafe(created ?? 0),
      updated: DateTime.makeUnsafe(updated ?? created ?? 0),
    },
    title: typeof title === "string" ? title : "",
    location: input.location,
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Select native Sessions for a listing page using exactly the key the
 * TypeScript catalog pages by: `time.created` then `id`, filtered by the same
 * anchor predicate and direction. A previous page flips the traversal order,
 * pages in the flipped order, and reverses back into the requested order —
 * mirroring the catalog so both sources cut the merged page at the same
 * element. `limit` truncates after ordering, so the caller can merge this
 * prefix with the TypeScript prefix of the same size and keep the correct page
 * overall.
 */
export function selectNativeSessions(input: {
  sessions: readonly SessionInfo.Info[]
  order: "asc" | "desc"
  anchor?: { readonly id: string; readonly time: number; readonly direction?: "previous" | "next" }
  search?: string
  limit: number
}): readonly SessionInfo.Info[] {
  const { anchor, order } = input
  const direction = anchor?.direction ?? "next"
  const traversal = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const wanted = input.search
    ? input.sessions.filter((session) => session.title.includes(input.search!))
    : input.sessions
  const anchored = anchor
    ? wanted.filter((session) => {
        const time = DateTime.toEpochMillis(session.time.created)
        if (time !== anchor.time) return traversal === "asc" ? time > anchor.time : time < anchor.time
        return traversal === "asc" ? session.id > anchor.id : session.id < anchor.id
      })
    : wanted
  const listed = [...anchored].sort(compareSessions(traversal)).slice(0, input.limit)
  return direction === "previous" ? listed.toReversed() : listed
}

/** The catalog's paging comparator, shared by selection and the final merge. */
export function compareSessions(order: "asc" | "desc") {
  return (left: SessionInfo.Info, right: SessionInfo.Info) => {
    const delta = DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created)
    if (delta !== 0) return order === "asc" ? delta : -delta
    const ids = left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    return order === "asc" ? ids : -ids
  }
}

/** Merge in traversal order so previous pages keep the nearest candidates. */
export function mergeListingPage(input: {
  sessions: readonly SessionInfo.Info[]
  native: readonly SessionInfo.Info[]
  nativeIDs: ReadonlySet<string>
  order: "asc" | "desc"
  direction?: "previous" | "next"
  limit: number
}) {
  const order = input.direction === "previous" ? (input.order === "asc" ? "desc" : "asc") : input.order
  const entries = new Map(
    [...input.sessions.filter((session) => !input.nativeIDs.has(session.id)), ...input.native].map(
      (session) => [session.id, session] as const,
    ),
  )
  const page = [...entries.values()].sort(compareSessions(order)).slice(0, input.limit)
  return input.direction === "previous" ? page.toReversed() : page
}

/**
 * Join native Sessions to a listing page. Each placement names its storage and
 * Location, so one engine child per storage answers the read; the entries then
 * take part in the same `(time, id)` ordering as the catalog, and both sides
 * contribute a `limit`-sized prefix before the merge is trimmed, which keeps
 * the page correct.
 *
 * Every page merges: an anchored request passes the cursor's anchor here, so
 * the catalog prefix and the native prefix are cut at the same element and the
 * merged page continues seamlessly across sources in both directions.
 */
export const mergeNativeSessions = Effect.fn("NativeSession.mergeSessions")(function* (input: {
  native: NativeEngine.Interface
  db: Database.Interface["db"]
  sessions: readonly SessionInfo.Info[]
  limit: number
  order: "asc" | "desc"
  anchor?: { readonly id: string; readonly time: number; readonly direction?: "previous" | "next" }
  directory?: AbsolutePath
  project?: Project.ID
  search?: string
  /** The caller's project service; directories are resolved through it. */
  projects: { resolve: (directory: AbsolutePath) => Effect.Effect<{ id: Project.ID }> }
}) {
  const placements = yield* SessionEnginePlacement.list(input.db)
  const groups = new Map<string, { storage: AbsolutePath; location: Location.Ref; sessions: string[] }>()
  for (const placement of placements) {
    if (input.directory && placement.location.directory !== input.directory) continue
    const key = `${placement.storage}\u0000${placement.location.directory}`
    const group = groups.get(key) ?? { storage: placement.storage, location: placement.location, sessions: [] }
    group.sessions.push(placement.sessionID)
    groups.set(key, group)
  }
  const entries: SessionInfo.Info[] = []
  for (const group of groups.values()) {
    const project = (yield* input.projects.resolve(group.location.directory)).id
    if (input.project && project !== input.project) continue
    for (const raw of group.sessions) {
      const sessionID = Schema.decodeUnknownSync(SessionID)(raw)
      const snapshot = yield* input.native.snapshot({ sessionID, storage: group.storage, location: group.location })
      entries.push(nativeSessionInfo({ sessionID, projectID: project, location: group.location, snapshot }))
    }
  }
  const selected = selectNativeSessions({
    sessions: entries,
    order: input.order,
    anchor: input.anchor,
    search: input.search,
    limit: input.limit,
  })
  return mergeListingPage({
    sessions: input.sessions,
    native: selected,
    nativeIDs: new Set(placements.map((placement) => placement.sessionID)),
    order: input.order,
    direction: input.anchor?.direction,
    limit: input.limit,
  })
})
