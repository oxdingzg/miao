import type { SessionsActivityOutput } from "@miao/client"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useRoute } from "./route"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { watchSessionStatus } from "./session-status"
import { sessionState } from "../util/session-state"

/** One observation shared by terminal badges, the sidebar and background timers. */
export const { use: useSessionState, provider: SessionStateProvider } = createSimpleContext({
  name: "SessionState",
  init: () => {
    const route = useRoute()
    const sdk = useSDK()
    const sync = useSync()
    const [store, setStore] = createStore<{
      sessionID?: string
      snapshot?: { activity: SessionsActivityOutput; receivedAt: number }
      stale?: number
      verified: boolean
    }>({ verified: false })
    const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

    createEffect(() => {
      const id = sessionID()
      setStore({ sessionID: id, snapshot: undefined, stale: undefined, verified: false })
    })

    createEffect(() => {
      const id = sessionID()
      if (!id) return
      // Invalidate the old idle snapshot even for turns shorter than a poll.
      // Busy/idle events restart this single reader immediately.
      sync.data.session_status[id]?.type
      setStore("verified", false)
      const abort = new AbortController()
      const stop = watchSessionStatus({
        interval: 2000,
        idleInterval: 5000,
        read: async () => {
          const [status, activity] = await Promise.all([
            sync.session.syncStatus(id, abort.signal),
            sdk.api.sessions.activity({ sessionID: id }, { signal: abort.signal }),
          ])
          if (abort.signal.aborted) return "idle"
          setStore({ snapshot: { activity, receivedAt: performance.now() }, stale: undefined, verified: true })
          return status === "busy" ||
            activity.pendingNotifications > 0 ||
            activity.schedules.length > 0 ||
            activity.jobs.some((job) => job.status === "running")
            ? "busy"
            : "idle"
        },
        onError: () => {
          if (!abort.signal.aborted) setStore("stale", (current) => current ?? performance.now())
        },
      })
      onCleanup(() => {
        stop()
        abort.abort()
      })
    })

    const state = createMemo(() => {
      const id = sessionID()
      if (!id) return "idle" as const
      return sessionState({
        status: sync.data.session_status[id],
        blocked: (sync.data.permission[id]?.length ?? 0) + (sync.data.question[id]?.length ?? 0) > 0,
        error: sync.data.session_error[id],
        todos: sync.data.todo[id] ?? [],
        message: sync.data.message[id]?.at(-1),
        activity: store.snapshot?.activity,
        pendingInputs: sync.prompt.waiting(id).length > 0,
        unavailable:
          !store.verified ||
          store.stale !== undefined ||
          sync.data.todo[id] === undefined ||
          sync.data.message[id] === undefined,
      })
    })
    return { data: store, state }
  },
})
