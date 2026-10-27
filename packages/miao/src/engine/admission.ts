import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { makeGlobalNode } from "@miao/core/effect/app-node"
import { SessionAdmission } from "@miao/core/session/admission"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionInput } from "@miao/core/session/input"
import { SessionStore } from "@miao/core/session/store"
import { Effect, Layer } from "effect"
import { SessionMessage } from "@miao/schema/session-message"
import type { SessionID } from "@miao/schema/session-id"
import type { Location } from "@miao/schema/location"
import type { AbsolutePath } from "@miao/core/schema"
import type { NativeEngine } from "@miao/server/native-engine"
import { currentTransport } from "./native-engine"

/** The admission router only moves prompts and vetoes; the rest of the
 * transport (titles, transcripts, catalog) stays out of its contract. */
type Transport = Pick<NativeEngine.Interface, "admit" | "cancelInput" | "storageRoot">

interface Deps {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly sessions: SessionStore.Interface
  readonly native: Transport | undefined
}

/** `MIAO_INPUT_TS_ADMIT=1` puts every admission back on the pre-S2 TS writer. */
const tsAdmitRequested = () => process.env.MIAO_INPUT_TS_ADMIT === "1"

interface Target {
  readonly storage: AbsolutePath
  readonly location: Location.Ref
}

/**
 * The engine storage that owns one Session's inbox: a native binding names it
 * directly; a TS-owned Session shares its Location's engine storage, which the
 * engine initializes on first admission.
 */
const engineTarget = Effect.fn("SessionAdmissionEngine.target")(function* (deps: Deps, sessionID: SessionID) {
  const placement = yield* SessionEnginePlacement.find(deps.db, sessionID)
  if (placement?.engine === "rust") return { storage: placement.storage, location: placement.location }
  const root = deps.native?.storageRoot ?? process.env.MIAO_ENGINE_STORAGE
  if (!root) return undefined
  const session = yield* deps.sessions.get(sessionID).pipe(Effect.orDie)
  if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
  return {
    storage: SessionEnginePlacement.storageFor(root, session.location),
    location: session.location,
  }
})

export const admit = Effect.fn("SessionAdmissionEngine.admit")(function* (
  deps: Deps,
  input: {
    readonly sessionID: SessionID
    readonly id: SessionMessage.ID
    readonly prompt: Parameters<SessionAdmission.Interface["admit"]>[0]["prompt"]
    readonly delivery: SessionInput.Delivery
  },
) {
  if (tsAdmitRequested()) return yield* SessionInput.admit(deps.db, deps.events, input)
  const native = deps.native
  const target: Target | undefined = native ? yield* engineTarget(deps, input.sessionID) : undefined
  if (!native || !target) return yield* SessionInput.admit(deps.db, deps.events, input)
  return yield* native
    .admit({
      sessionID: input.sessionID,
      storage: target.storage,
      location: target.location,
      id: input.id,
      prompt: input.prompt,
      delivery: input.delivery,
      // TS-owned execution drains the projection itself; only natively placed
      // Sessions let the engine start a run on admission.
      resume: undefined,
    })
    .pipe(
      // Callers keep their pre-S2 conflict mapping: an engine refusal is the
      // same LifecycleConflict defect the TS writer died with.
      Effect.catch(() => Effect.die(new SessionInput.LifecycleConflict({ id: input.id }))),
    )
})

export const cancel = Effect.fn("SessionAdmissionEngine.cancel")(function* (
  deps: Deps,
  input: { readonly sessionID: SessionID; readonly id: SessionMessage.ID },
) {
  if (tsAdmitRequested()) return yield* SessionInput.cancel(deps.db, deps.events, input)
  const native = deps.native
  const target: Target | undefined = native ? yield* engineTarget(deps, input.sessionID) : undefined
  if (native && target) {
    // The engine row is the durable veto: a cancelled admission identity can
    // never be re-admitted there, whether or not a projection exists yet.
    yield* native
      .cancelInput({
        sessionID: input.sessionID,
        storage: target.storage,
        location: target.location,
        inputID: input.id,
      })
      .pipe(Effect.catch(() => Effect.die(new SessionInput.LifecycleConflict({ id: input.id }))))
  }
  return yield* SessionInput.cancel(deps.db, deps.events, input)
})

const layer = Layer.effect(
  SessionAdmission.Service,
  Effect.gen(function* () {
    const deps: Deps = {
      db: (yield* Database.Service).db,
      events: yield* EventV2.Service,
      sessions: yield* SessionStore.Service,
      native: currentTransport(),
    }
    return SessionAdmission.Service.of({
      admit: (input) => admit(deps, input),
      cancel: (input) => cancel(deps, input),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionAdmission.Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Database.node, EventV2.node, SessionStore.node],
})

export * as AdmissionEngine from "./admission"
