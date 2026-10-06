export * as SessionHeal from "./heal"

import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { AbsolutePath } from "../schema"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"

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
  yield* input.events.publish(SessionEvent.Moved, {
    sessionID: input.sessionID,
    location: Location.Ref.make({ directory: checkout }),
    timestamp: yield* DateTime.now,
  })
  yield* Effect.logWarning("relocated a Session away from its missing directory", {
    sessionID: input.sessionID,
    from: input.directory,
    to: checkout,
  })
  return checkout
})
