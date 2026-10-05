export * as SessionDelegation from "./delegation"

import { randomUUID } from "node:crypto"
import { Cause, DateTime, Duration, Effect, Exit, FiberSet, Semaphore, Stream } from "effect"
import { ToolFailure } from "@miao/llm"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { Hash } from "../util/hash"
import { SessionDelegationStore } from "./delegation-store"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import type { SessionSchema } from "./schema"
import type { SessionStore } from "./store"

export const invocationID = (sessionID: SessionSchema.ID, messageID: SessionMessage.ID, callID: string) =>
  `task_${Hash.sha256(JSON.stringify([sessionID, messageID, callID]))}`

export type Request = {
  id: string
  sessionID: SessionSchema.ID
  agent: string
  prompt: string
  description: string
  taskId?: string
  budget?: number
  createChild: () => Effect.Effect<SessionSchema.Info>
}
export type API = Effect.Success<ReturnType<typeof make>>

const owners = new Set<string>()
function ownerAlive(owner: string) {
  if (owners.has(owner)) return true
  const pid = Number(owner.split(":")[0])
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission failure is not evidence that another process died.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

/** Runtime-owned watchers survive the parent tool/turn; execution stays coordinator-owned. */
export const make = (input: {
  db: Database.Interface["db"]
  events: EventV2.Interface
  store: SessionStore.Interface
  wake: (id: SessionSchema.ID) => Effect.Effect<void>
  wait: (id: SessionSchema.ID) => Effect.Effect<void>
  executions: Effect.Effect<ReadonlyMap<SessionSchema.ID, string>>
  interruptIf: (id: SessionSchema.ID, execution: string) => Effect.Effect<boolean>
  maximum?: number
  silence?: Duration.Input
}) =>
  Effect.gen(function* () {
    const owner = `${process.pid}:${randomUUID()}`
    owners.add(owner)
    yield* Effect.addFinalizer(() => Effect.sync(() => owners.delete(owner)))
    const gate = Semaphore.makeUnsafe(1)
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const observed = new Map<string, { sessionID: SessionSchema.ID; execution: string }>()
    const maximum = input.maximum ?? 4

    const finish = (
      task: SessionDelegationStore.Info,
      status: SessionEvent.DelegationEnded["data"]["status"],
      text: string,
    ) =>
      Effect.gen(function* () {
        const current = yield* SessionDelegationStore.get(input.db, task.session_id, task.id)
        if (!current || current.status !== "running") return
        yield* input.events.publish(SessionEvent.DelegationEnded, {
          sessionID: task.session_id,
          id: task.id,
          status,
          text,
          timestamp: yield* DateTime.now,
        })
        yield* input.wake(task.session_id)
      })

    const watch = (task: SessionDelegationStore.Info) =>
      Effect.gen(function* () {
        const launched = yield* gate.withPermit(
          Effect.gen(function* () {
            const current = yield* SessionDelegationStore.get(input.db, task.session_id, task.id)
            if (current?.status !== "running") return false
            yield* input.wake(task.child_session_id)
            const execution = (yield* input.executions).get(task.child_session_id)
            if (execution) observed.set(task.id, { sessionID: task.child_session_id, execution })
            return true
          }),
        )
        if (!launched) return
        const outcome = yield* Effect.raceFirst(
          input.wait(task.child_session_id).pipe(Effect.as("idle" as const)),
          input.events.all().pipe(
            Stream.filter((event) => event.durable?.aggregateID === task.child_session_id),
            Stream.timeout(input.silence ?? Duration.minutes(15)),
            Stream.runDrain,
            Effect.as("stalled" as const),
          ),
        )
        if (outcome === "stalled") {
          const owned = observed.get(task.id)
          if (owned) yield* input.interruptIf(owned.sessionID, owned.execution)
          return yield* finish(
            task,
            "failed",
            "Subagent produced no events within its silence limit. Inspect its child Session before retrying.",
          )
        }
        const child = yield* input.store.get(task.child_session_id)
        if (!child)
          return yield* finish(task, "failed", "The child Session was deleted before a report could be collected.")
        const context = (yield* SessionHistory.all(input.db, child.id)).map((entry) => entry.message)
        const promptIndex = context.findIndex((message) => message.id === task.prompt_message_id)
        const assistant = context.slice(promptIndex + 1).findLast((message) => message.type === "assistant")
        if (
          promptIndex < 0 ||
          assistant?.type !== "assistant" ||
          assistant.time.completed === undefined ||
          assistant.error ||
          assistant.finish === "error" ||
          assistant.finish === "tool-calls"
        )
          return yield* finish(
            task,
            "failed",
            "Subagent did not return a completed report. Inspect its child Session; earlier tool effects may have completed.",
          )
        const text = assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        return yield* finish(
          task,
          text.trim() ? "completed" : "failed",
          text.trim()
            ? text
            : "Subagent returned an empty report; inspect its child transcript rather than treating this as success.",
        )
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? finish(
                task,
                Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
                "Background delegation stopped before report delivery. Its outcome is unknown; inspect the child Session before retrying.",
              )
            : Effect.void,
        ),
        Effect.ensuring(Effect.sync(() => observed.delete(task.id))),
        Effect.exit,
        Effect.asVoid,
      )

    const start = (request: Request) =>
      gate.withPermit(
        Effect.gen(function* () {
          const existing = yield* SessionDelegationStore.get(input.db, request.sessionID, request.id)
          if (existing) {
            if (
              existing.agent !== request.agent ||
              existing.prompt !== request.prompt ||
              existing.description !== request.description ||
              (request.taskId !== undefined && existing.child_session_id !== request.taskId)
            )
              return yield* new ToolFailure({
                message: "Background task invocation was reused with conflicting arguments.",
              })
            return {
              sessionID: existing.child_session_id,
              taskID: existing.id,
              background: true as const,
              text: `Background task ${existing.id} is ${existing.status}.`,
            }
          }
          if ((yield* SessionDelegationStore.activeCount(input.db, request.sessionID)) >= maximum)
            return yield* new ToolFailure({
              message: `This Session already has ${maximum} active background subagents. Wait for or cancel one before starting another.`,
            })
          if ((yield* SessionDelegationStore.notificationCount(input.db, request.sessionID)) >= 64)
            return yield* new ToolFailure({
              message: "This Session has too many unread background reports; process them before spawning more work.",
            })
          const parent = yield* input.store.get(request.sessionID)
          if (!parent) return yield* new ToolFailure({ message: "Parent Session no longer exists." })
          // Session projection already aggregates descendant usage into parent.cost.
          if (request.budget !== undefined && parent.cost >= request.budget)
            return yield* new ToolFailure({ message: "Parent Session's aggregate cost budget is exhausted." })
          const child = yield* request.createChild()
          if (child.parentID !== request.sessionID || child.projectID !== parent.projectID)
            return yield* new ToolFailure({
              message: "Background task cannot adopt a child owned by another Session/project.",
            })
          const busyChild = (yield* SessionDelegationStore.list(input.db, request.sessionID)).some(
            (task) => task.child_session_id === child.id && task.status === "running",
          )
          if (busyChild) return yield* new ToolFailure({ message: "This child already has an active background task." })
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const promptMessageID = SessionMessage.ID.create()
              yield* input.events.publish(SessionEvent.DelegationStarted, {
                sessionID: request.sessionID,
                id: request.id,
                childSessionID: child.id,
                promptMessageID,
                agent: request.agent,
                prompt: request.prompt,
                description: request.description,
                owner,
                timestamp: yield* DateTime.now,
              })
              yield* SessionInput.admit(input.db, input.events, {
                id: promptMessageID,
                sessionID: child.id,
                prompt: Prompt.make({ text: request.prompt }),
                delivery: "steer",
              })
              const task = yield* SessionDelegationStore.get(input.db, request.sessionID, request.id)
              if (!task) return yield* Effect.die("Delegation admission was not projected")
              fork(watch(task))
              return {
                sessionID: child.id,
                taskID: task.id,
                background: true as const,
                text: `Background task ${task.id} started in child Session ${child.id}. Its result will arrive as a synthetic notification; continue independent work.`,
              }
            }),
          )
        }),
      )

    return {
      start,
      recover: (sessionID: SessionSchema.ID) =>
        gate.withPermit(SessionDelegationStore.recover(input.db, input.events, sessionID, owner, ownerAlive)),
      list: (sessionID: SessionSchema.ID) => SessionDelegationStore.list(input.db, sessionID),
      result: (sessionID: SessionSchema.ID, id: string) => SessionDelegationStore.get(input.db, sessionID, id),
      cancel: (sessionID: SessionSchema.ID, id: string) =>
        gate.withPermit(
          Effect.gen(function* () {
            const task = yield* SessionDelegationStore.get(input.db, sessionID, id)
            if (!task || task.status !== "running") return false
            if (task.owner !== owner)
              return yield* new ToolFailure({
                message: "This task is owned by another runtime; cancellation cannot steal its execution.",
              })
            yield* finish(
              task,
              "cancelled",
              "Background task cancellation was requested; inspect child tool outcomes before retrying.",
            )
            if ((yield* SessionDelegationStore.get(input.db, sessionID, id))?.status !== "cancelled") return false
            const owned = observed.get(id)
            if (owned) yield* input.interruptIf(owned.sessionID, owned.execution)
            return true
          }),
        ),
    }
  })
