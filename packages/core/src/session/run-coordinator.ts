export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Process-unique identities for the currently owned drains; never reused by successors. */
  readonly executions: Effect.Effect<ReadonlyMap<Key, string>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /** Interrupt only the observed drain. Stale identities cannot stop subsequent work. */
  readonly interruptIf: (key: Key, execution: string) => Effect.Effect<boolean>
  /**
   * Waits until no execution is active for the key. Never fails; the drain
   * outcome is observed through durable state, not through this wait.
   */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
  execution: string
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  /**
   * Observes busy/idle transitions. Successor drains for coalesced wakes stay
   * busy, so one burst of work reports exactly one busy and one idle.
   */
  readonly status?: (key: Key, status: "busy" | "idle") => Effect.Effect<void>
  /**
   * Caps how many drains run concurrently across all keys. Omitted means no cap
   * (different keys always run concurrently, as before).
   */
  readonly maxConcurrent?: number
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const permits = options.maxConcurrent === undefined ? undefined : Semaphore.makeUnsafe(Math.max(1, options.maxConcurrent))
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    // Reports read the live state under one lock and skip repeats, so reports
    // from overlapping owners can never leave a stale busy or idle behind.
    const reported = new Set<Key>()
    const reporting = Semaphore.makeUnsafe(1)
    const report = (key: Key) =>
      reporting.withPermit(
        Effect.suspend(() => {
          const busy = active.has(key)
          if (busy === reported.has(key) || !options.status) return Effect.void
          if (busy) reported.add(key)
          else reported.delete(key)
          return options.status(key, busy ? "busy" : "idle")
        }),
      )

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
      execution: randomUUID(),
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      entry.execution = randomUUID()
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(report(key)),
          Effect.andThen(
            permits === undefined
              ? Effect.suspend(() => options.drain(key, force))
              : permits.withPermits(1)(Effect.suspend(() => options.drain(key, force))),
          ),
          Effect.onExit((exit) => settle(key, entry, exit)),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) =>
      Effect.suspend(() => {
        if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
          entry.pendingWake = false
          start(key, entry, false, true)
          return Effect.void
        }

        const successor = entry.pendingWake ? makeEntry() : undefined
        if (successor === undefined) active.delete(key)
        else {
          active.set(key, successor)
          start(key, successor, false, true)
        }
        // Report idle before waiters resume, so a caller that awaited the drain
        // has already seen the idle transition.
        return (successor === undefined ? report(key) : Effect.void).pipe(
          Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(entry.done, exit))),
        )
      })

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    // Interrupting stops the current drain but must not cancel work that was
    // already queued behind it. `pendingWake` therefore survives the interrupt,
    // and `settle` hands off to a successor drain that promotes the admitted
    // input. Clearing it here would strand durable input with no owner: the
    // session would report idle while its inbox still holds unpromoted rows,
    // and only a brand-new prompt would ever wake them again.
    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        return Fiber.interrupt(entry.owner)
      })

    const interruptIf = (key: Key, execution: string): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined || entry.execution !== execution || entry.stopping) return Effect.succeed(false)
        entry.stopping = true
        return Fiber.interrupt(entry.owner).pipe(Effect.as(true))
      })

    // A settled entry may hand off to a successor for a coalesced wake, so
    // re-check after each settle until the key is truly idle.
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry === undefined) return Effect.void
        return Deferred.await(entry.done).pipe(Effect.exit, Effect.asVoid, Effect.andThen(awaitIdle(key)))
      })

    return {
      active: Effect.sync(() => new Set(active.keys())),
      executions: Effect.sync(() => new Map(Array.from(active, ([key, entry]) => [key, entry.execution]))),
      run,
      wake,
      interrupt,
      interruptIf,
      awaitIdle,
    }
  })
