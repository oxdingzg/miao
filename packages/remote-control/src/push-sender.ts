export * as PushSender from "./push-sender"

import { DeviceGrants } from "./grants"
import { PushContext } from "./push-context"

export type Options = {
  hubURL: string
  hostToken: string
  runtimeID: string
  grants: DeviceGrants.Store
  connected: () => boolean
  projectForSession: (sessionID: string, signal: AbortSignal) => Promise<string | undefined>
  allowLoopbackHTTP?: boolean
}

/** Best-effort hints never queue or replay model work or session operations. */
export function make(options: Options) {
  const origin = new URL(options.hubURL)
  const local =
    options.allowLoopbackHTTP &&
    origin.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    (!local && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Invalid notification relay origin")
  const abort = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const busy = new Map<string, { failed: boolean }>()
  const observed = new Map<string, number>()
  const reconciled = new Map<string, number>()
  const state = { stopped: false }
  const post = async (route: string, body: unknown, until = Date.now() + 5000) => {
    if (state.stopped || !options.connected() || Date.now() >= until) return false
    const response = await fetch(origin.origin + `/api/hub/hosts/${options.grants.hostID}/push/` + route, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${options.hostToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(5000, until - Date.now())))]),
    })
    // The sender needs only admission status; never retain an unbounded response body.
    await response.body?.cancel()
    return response.ok
  }
  const synchronize = async (until: number) => {
    for (const grant of options.grants.list()) {
      if (grant.revokedAt === null || reconciled.get(grant.id) === grant.version) continue
      if (Date.now() >= until) return false
      if (!(await post("revoke", { grantID: grant.id, grantVersion: grant.version }, until))) return false
      reconciled.set(grant.id, grant.version)
    }
    return true
  }
  const send = async (sessionID: string, kind: "attention" | "completed") => {
    const until = Date.now() + 30_000
    if (state.stopped || !options.connected() || !(await synchronize(until)) || Date.now() >= until) return
    const projectID = await options.projectForSession(
      sessionID,
      AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(5000, until - Date.now())))]),
    )
    if (!projectID || state.stopped || !options.connected()) return
    const devices = new Set<string>()
    const grants = options.grants
      .list()
      .filter(
        (grant) =>
          grant.revokedAt === null &&
          grant.expiresAt > Date.now() &&
          grant.permissions.includes("read") &&
          (grant.sessionIDs.includes(sessionID) || grant.projectIDs.includes(projectID)),
      )
      .filter((grant) => {
        if (devices.has(grant.publicKey) || devices.size >= 32) return false
        devices.add(grant.publicKey)
        return true
      })
    // Sequential per signal keeps one event from exhausting the transport budget.
    for (const grant of grants) {
      if (state.stopped || !options.connected() || Date.now() >= until) return
      const binding = {
        hostID: options.grants.hostID,
        runtimeID: options.runtimeID,
        grantID: grant.id,
        grantVersion: grant.version,
        deviceID: grant.publicKey,
        signalID: crypto.randomUUID(),
      }
      const context = await PushContext.seal(options.grants.identity, binding, {
        sessionID,
        projectID,
        expiresAt: Math.min(Date.now() + 10 * 60_000, grant.expiresAt),
      })
      const current = options.grants.get(grant.id, grant.publicKey)
      if (
        state.stopped ||
        Date.now() >= until ||
        !options.connected() ||
        current?.version !== grant.version ||
        !current.permissions.includes("read") ||
        (!current.sessionIDs.includes(sessionID) && !current.projectIDs.includes(projectID))
      )
        continue
      await post("send", { ...binding, kind, context }, until)
    }
  }
  const track = (job: Promise<unknown>) => {
    const bounded = job.catch(() => undefined).finally(() => pending.delete(bounded))
    pending.add(bounded)
  }
  return {
    accept(event: { id?: string; type: string; data: unknown }) {
      if (state.stopped || typeof event.data !== "object" || event.data === null) return
      const data = event.data as Record<string, unknown>
      if (typeof data.sessionID !== "string") return
      const sessionID = data.sessionID
      if (event.type === "session.next.status") {
        const status = data.status as { type?: unknown } | undefined
        if (status?.type === "busy") {
          if (!busy.has(sessionID) && busy.size < 128) busy.set(sessionID, { failed: false })
          return
        }
        if (status?.type !== "idle") return
        const previous = busy.get(sessionID)
        busy.delete(sessionID)
        if (!previous || previous.failed || pending.size >= 4 || !options.connected()) return
        track(send(sessionID, "completed"))
        return
      }
      if (!["permission.v2.asked", "question.v2.asked", "session.next.failed"].includes(event.type)) return
      if (event.type === "session.next.failed") {
        const previous = busy.get(sessionID)
        if (previous) previous.failed = true
      }
      if (!event.id || pending.size >= 4 || !options.connected()) return
      for (const [id, until] of observed) if (until <= Date.now()) observed.delete(id)
      if (observed.has(event.id) || observed.size >= 1024) return
      observed.set(event.id, Date.now() + 10 * 60_000)
      track(send(sessionID, "attention"))
    },
    revoke: async (grant: DeviceGrants.Grant) => {
      if (grant.revokedAt === null) return
      if (await post("revoke", { grantID: grant.id, grantVersion: grant.version }).catch(() => false))
        reconciled.set(grant.id, grant.version)
    },
    drain: async () => {
      await Promise.allSettled([...pending])
    },
    stop: async () => {
      state.stopped = true
      abort.abort()
      await Promise.allSettled([...pending])
      busy.clear()
      observed.clear()
      reconciled.clear()
    },
  }
}
