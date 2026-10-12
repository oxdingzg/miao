export * as SessionRouting from "./routing"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionHeal } from "./heal"
import { SessionTable } from "./sql"

export type Resolution =
  /** The durable placement catalog knows the Session; its engine owns it. */
  | { type: "placed"; engine: "rust"; location: Location.Ref }
  | { type: "placed"; engine: "ts"; location: Location.Ref }
  /** A legacy TS Session row exists without a binding; the TS engine owns it. */
  | { type: "unbound"; location: Location.Ref }
  /** The TS row's directory vanished and its checkout could not take it back. */
  | { type: "missing"; directory: string }
  /** No placement and no TS row: the Session does not exist. */
  | { type: "unknown" }

/** Which engine a resolved Session may be served by. */
export type Route = "ts" | "native" | "missing" | "unknown"

/**
 * The serving decision for a resolution. A Rust-owned Session is `native`: the
 * TypeScript handlers have no authority over it, so a TS route must neither read
 * nor write its metadata. Keeping the decision here makes it testable without a
 * server harness, and the middleware only maps it to a transport error.
 */
export function route(resolution: Resolution): Route {
  switch (resolution.type) {
    case "placed":
      return resolution.engine === "rust" ? "native" : "ts"
    case "unbound":
      return "ts"
    case "missing":
      return "missing"
    case "unknown":
      return "unknown"
  }
}

/**
 * Resolve where a Session lives and which engine owns it. The durable placement
 * catalog is the authority: a Rust-owned Session resolves from its binding and
 * is never read or healed through TS metadata, so a request cannot resurrect a
 * TS row for a Session the native engine owns. Only unbound/legacy TS Sessions
 * fall back to the TS row and its orphan relocation.
 */
export const resolve = Effect.fn("SessionRouting.resolve")(function* (input: {
  db: Database.Interface["db"]
  events: EventV2.Interface
  fs: FSUtil.Interface
  sessionID: SessionID
}) {
  const placement = yield* SessionEnginePlacement.find(input.db, input.sessionID)
  if (placement?.engine === "rust") {
    // The native engine owns the Session and its storage; the TS side must not
    // relocate it. Report a vanished Location instead of serving a dead path.
    if (!(yield* input.fs.existsSafe(placement.location.directory)))
      return { type: "missing", directory: placement.location.directory } as const
    return { type: "placed", engine: "rust", location: placement.location } as const
  }

  const row = yield* input.db
    .select({
      directory: SessionTable.directory,
      workspaceID: SessionTable.workspace_id,
      projectID: SessionTable.project_id,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return { type: "unknown" } as const

  const directory = yield* SessionHeal.relocateOrphan({
    db: input.db,
    events: input.events,
    fs: input.fs,
    sessionID: input.sessionID,
    directory: AbsolutePath.make(row.directory),
    projectID: row.projectID,
  })
  if (!directory) return { type: "missing", directory: row.directory } as const
  const location = Location.Ref.make({
    directory,
    ...(row.workspaceID ? { workspaceID: WorkspaceV2.ID.make(row.workspaceID) } : {}),
  })
  if (placement?.engine === "ts") return { type: "placed", engine: "ts", location } as const
  return { type: "unbound", location } as const
})
