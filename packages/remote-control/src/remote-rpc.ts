export * as RemoteRPC from "./remote-rpc"

import type { RemoteAccess } from "@miao/schema/remote-access"
import type { ControlAgent } from "./agent"
import type { SecureChannel } from "./secure-channel"

export type Transport = {
  send(value: unknown): Promise<void>
  receive(timeout?: number): Promise<unknown>
  close(): void
}
export class RequestError extends Error {
  constructor(readonly code: string) { super("Remote request failed: " + code) }
}

/** One authenticated connection. Writes require a caller-persisted operation ID and are never replayed here. */
export function make(input: {
  transport: Transport
  target: SecureChannel.Target
  grant: RemoteAccess.Grant
  identityPublicKey: string
}) {
  const grant = structuredClone(input.grant)
  const target = { ...input.target }
  if (grant.publicKey !== input.identityPublicKey || grant.expiresAt <= Date.now() || grant.revokedAt !== null ||
      !Number.isSafeInteger(grant.version) || grant.version < 1)
    throw new Error("Device grant does not authorize this identity")
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; write: boolean; timer: ReturnType<typeof setTimeout> }>()
  let closed = false
  const close = (code = "disconnected") => {
    if (closed) return
    closed = true
    input.transport.close()
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new RequestError(request.write ? "outcome_unknown" : code)) }
    pending.clear()
  }
  const reader = (async () => {
    try {
      while (!closed) {
        const value = await input.transport.receive(2147483647)
        if (closed) return
        if (!isObject(value) || value.version !== 1 || typeof value.requestID !== "string" ||
            (value.type !== "result" && value.type !== "error")) throw new Error("Invalid RPC envelope")
        const request = pending.get(value.requestID)
        // A timed-out read may still return. Its result cannot resolve a newer request.
        if (!request) continue
        pending.delete(value.requestID); clearTimeout(request.timer)
        if (value.type === "result") request.resolve(value.data)
        else {
          const code = typeof value.code === "string" && errors.has(value.code) ? value.code : "unavailable"
          request.reject(new RequestError(code))
        }
      }
    } catch { close() }
  })()
  return {
    close: () => close(),
    stopped: () => closed,
    finished: reader,
    request: (method: ControlAgent.Method, options: {
      sessionID?: string; projectID?: string; operationID?: string; payload?: unknown; timeout?: number
    } = {}): Promise<unknown> => {
      if (closed) return Promise.reject(new RequestError("disconnected"))
      if (grant.expiresAt <= Date.now()) { close("expired"); return Promise.reject(new RequestError("expired")) }
      if (pending.size >= 32) return Promise.reject(new RequestError("busy"))
      const timeout = options.timeout ?? 15000
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300000 ||
          (writes.has(method) && (!options.operationID || !operationID.test(options.operationID))) ||
          (options.operationID !== undefined && !operationID.test(options.operationID)))
        return Promise.reject(new RequestError("invalid_request"))
      const requestID = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestID)
          reject(new RequestError(writes.has(method) ? "outcome_unknown" : "timeout"))
        }, timeout)
        pending.set(requestID, { resolve, reject, write: writes.has(method), timer })
        void input.transport.send({ version: 1, requestID, ...target, grantID: grant.id, grantVersion: grant.version,
          method, sessionID: options.sessionID, projectID: options.projectID, operationID: options.operationID,
          payload: options.payload ?? {} }).catch(() => close())
      })
    },
  }
}

const writes = new Set<ControlAgent.Method>(["session.create", "session.prompt", "session.interrupt", "session.rename", "session.switchAgent", "session.switchModel", "permission.reply", "question.reply"])
const errors = new Set(["forbidden", "not_found", "conflict", "expired", "outcome_unknown", "invalid_request", "unavailable"])
const operationID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
