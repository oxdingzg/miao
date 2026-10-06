export * as SessionPlacement from "./placement"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { MoveSession } from "../control-plane/move-session"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import { ProjectWorktree } from "../project/worktree"
import { AbsolutePath } from "../schema"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export const EnterResult = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  branch: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionPlacement.EnterResult" })
export type EnterResult = Schema.Schema.Type<typeof EnterResult>

export const ExitResult = Schema.Struct({
  directory: Schema.String,
  removed: Schema.Boolean,
}).annotate({ identifier: "SessionPlacement.ExitResult" })
export type ExitResult = Schema.Schema.Type<typeof ExitResult>

export class PlacementError extends Schema.TaggedErrorClass<PlacementError>()("SessionPlacement.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Creates a git worktree for the Session's project and moves the Session into it. */
  readonly enterWorktree: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name?: string
    readonly copyChanges?: boolean
  }) => Effect.Effect<EnterResult, PlacementError>
  /** Returns the Session to the checkout its worktree was created from. */
  readonly exitWorktree: (input: {
    readonly sessionID: SessionSchema.ID
    readonly action: "keep" | "remove"
  }) => Effect.Effect<ExitResult, PlacementError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/SessionPlacement") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const projects = yield* ProjectV2.Service
    const worktrees = yield* ProjectWorktree.Service
    const move = yield* MoveSession.Service
    const { db } = yield* Database.Service

    /**
     * Where a worktree operation is anchored. `Git.repo.discover` reports the
     * worktree it ran in, so the shared `.git` directory is what identifies the
     * primary checkout from either side of the move; `worktree` is which of the
     * two the Session is in now.
     */
    const placementRoot = Effect.fnUntraced(function* (directory: AbsolutePath) {
      const project = yield* projects.resolve(directory)
      if (!project.vcs) return undefined
      return {
        projectID: project.id,
        worktree: project.directory,
        checkout: AbsolutePath.make(path.dirname(project.vcs.store)),
      }
    })

    const asError = (fallback: string) => (error: { readonly _tag: string; readonly message?: string }) =>
      new PlacementError({ message: error.message ?? `${fallback} (${error._tag})` })

    // A moved Session cannot keep running in the runner that served the move: the
    // runner refuses a turn whose Session location no longer matches its own. The
    // reminder is admitted as a steer so the runner that owns the new directory
    // has something to promote once it is woken.
    const remind = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, text: string) {
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: Prompt.make({ text: `<system-reminder>${text}</system-reminder>` }),
        delivery: "steer",
      })
    })

    const enterWorktree = Effect.fn("SessionPlacement.enterWorktree")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly name?: string
      readonly copyChanges?: boolean
    }) {
      const session = yield* store.get(input.sessionID)
      if (!session) return yield* new PlacementError({ message: "Unknown Session." })
      const target = yield* placementRoot(AbsolutePath.make(session.location.directory))
      if (!target) return yield* new PlacementError({ message: "Worktrees need a git repository." })
      const created = yield* worktrees
        .create(
          { projectID: target.projectID, checkout: target.checkout, git: true },
          input.name ? { name: input.name } : undefined,
        )
        .pipe(Effect.mapError(asError("Unable to create the worktree")))
      yield* move
        .moveSession({
          sessionID: input.sessionID,
          destination: { directory: AbsolutePath.make(created.directory) },
          moveChanges: input.copyChanges,
        })
        .pipe(Effect.mapError(asError("Unable to move the Session into the worktree")))
      yield* remind(
        input.sessionID,
        `The Session now works in the git worktree "${created.name}" at "${created.directory}"` +
          `${created.branch ? ` on branch ${created.branch}` : ""}. Every tool call from here runs in that ` +
          `directory. Commit anything that matters before leaving with exit_worktree.`,
      )
      return {
        name: created.name,
        directory: created.directory,
        ...(created.branch ? { branch: created.branch } : {}),
      }
    })

    const exitWorktree = Effect.fn("SessionPlacement.exitWorktree")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly action: "keep" | "remove"
    }) {
      const session = yield* store.get(input.sessionID)
      if (!session) return yield* new PlacementError({ message: "Unknown Session." })
      const target = yield* placementRoot(AbsolutePath.make(session.location.directory))
      if (!target) return yield* new PlacementError({ message: "Worktrees need a git repository." })
      if (target.worktree === target.checkout)
        return yield* new PlacementError({ message: "This Session is already in the project's primary checkout." })
      const removed = input.action === "remove"
      yield* move
        .moveSession({ sessionID: input.sessionID, destination: { directory: target.checkout } })
        .pipe(Effect.mapError(asError("Unable to move the Session back")))
      if (removed)
        yield* worktrees
          .remove(
            { projectID: target.projectID, checkout: target.checkout, git: true },
            { directory: target.worktree },
          )
          .pipe(Effect.mapError(asError("Unable to remove the worktree")))
      yield* remind(
        input.sessionID,
        `The Session is back in the project's primary checkout at "${target.checkout}".` +
          `${removed ? ` The worktree at "${target.worktree}" was removed.` : ""}`,
      )
      return { directory: target.checkout, removed }
    })

    return Service.of({ enterWorktree, exitWorktree })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionStore.node, ProjectV2.node, ProjectWorktree.node, MoveSession.node],
})
