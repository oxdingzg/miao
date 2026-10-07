export * as SessionHeal from "./heal"

import { and, eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { AbsolutePath } from "../schema"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

type DB = Database.Interface["db"]

export interface Input {
  readonly db: DB
  readonly events: EventV2.Interface
  readonly fs: FSUtil.Interface
  readonly sessionID: SessionSchema.ID
  readonly directory: AbsolutePath
  readonly projectID: ProjectV2.ID
}

/**
 * A Session whose stored directory vanished — typically a git worktree deleted
 * out-of-band, bypassing `ProjectWorktree.remove` — cannot open its Location:
 * every request that resolves the Session dies on `realPath` before reaching a
 * handler. Relocate such a Session to its project's primary checkout, where
 * `exit_worktree` would have returned it, so its history and resume keep
 * working. Returns the Session's usable directory, or undefined when no anchor
 * exists (unknown project, or the checkout is gone too).
 */
export const relocateOrphan = Effect.fn("SessionHeal.relocateOrphan")(function* (input: Input) {
  if (yield* input.fs.existsSafe(input.directory)) return input.directory
  const project = yield* input.db
    .select({ worktree: ProjectTable.worktree })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, input.projectID))
    .get()
    .pipe(Effect.orDie)
  if (!project) return undefined
  const checkout = AbsolutePath.make(project.worktree)
  if (checkout === input.directory) return undefined
  if (!(yield* input.fs.existsSafe(checkout))) return undefined
  const timestamp = yield* DateTime.now
  // Concurrent requests can both see the directory vanish before either writes
  // the row. Only the update that actually moves it may publish the event and
  // admit the model notice, or a racing request admits a second identical
  // reminder the user then sees twice in the transcript.
  const moved = yield* input.db
    .update(SessionTable)
    .set({ directory: checkout, time_updated: DateTime.toEpochMillis(timestamp) })
    .where(and(eq(SessionTable.id, input.sessionID), eq(SessionTable.directory, input.directory)))
    .run()
    .pipe(Effect.orDie)
  // This driver discards drizzle's run result, so read the connection's last
  // change count instead: 0 means a racing request relocated the row first.
  const changed = yield* input.db.get<{ changed: number }>(sql`SELECT changes() AS changed`).pipe(Effect.orDie)
  if ((changed?.changed ?? 0) === 0) return checkout
  yield* input.events.publish(SessionEvent.Moved, {
    sessionID: input.sessionID,
    location: Location.Ref.make({ directory: checkout }),
    timestamp,
  })
  // Without a model-visible notice the Session keeps addressing the vanished
  // directory and every path-based call fails until it stumbles onto the move.
  yield* SessionInput.admit(input.db, input.events, {
    id: SessionMessage.ID.create(),
    sessionID: input.sessionID,
    prompt: Prompt.make({
      text:
        `<system-reminder>The directory this Session worked in ("${input.directory}") no longer exists ` +
        `— its git worktree was deleted out-of-band. The Session has been moved back to the ` +
        `project checkout at "${checkout}". Use that directory for every later path.</system-reminder>`,
    }),
    delivery: "steer",
  })
  yield* Effect.logWarning("relocated a Session away from its missing directory", {
    sessionID: input.sessionID,
    from: input.directory,
    to: checkout,
  })
  return checkout
})
