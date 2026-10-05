export * as PushDispatch from "./push-dispatch"

import { PushProvider } from "./push-provider"
import { PushRegistry } from "./push-registry"

export type Notice = {
  signalID: string
  accountID: string
  deviceID: string
  hostID: string
  runtimeID: string
  grantID: string
  grantVersion: number
  kind: "attention" | "completed"
  /** Encrypted for the device; the relay cannot read session or project identities. */
  context: string
}
export type Options = {
  registry: ReturnType<typeof PushRegistry.open>
  provider: Pick<Awaited<ReturnType<typeof PushProvider.create>>, "send">
  environment: "sandbox" | "production"
  /** Recheck current host, Runtime and grant authorization immediately before transport submission. */
  authorized: (notice: Notice) => boolean
}

/** Bounded ephemeral hints. No replay queue or executable operation lives in the relay. */
export function make(options: Options) {
  const notices = new Map<
    string,
    {
      notice: Notice
      registrationID: string
      sessionID: string
      until: number
      status: PushProvider.Result["status"] | "sending"
    }
  >()
  const state = { stopped: false, active: 0 }
  const prune = () => {
    for (const [id, entry] of notices) if (entry.until <= Date.now()) notices.delete(id)
  }
  return {
    async send(input: Notice) {
      const notice = structuredClone(input)
      validate(notice)
      prune()
      if (state.stopped || !options.authorized(notice)) return { status: "rejected" as const }
      const existing = notices.get(notice.signalID)
      if (existing) {
        if (JSON.stringify(existing.notice) !== JSON.stringify(notice)) return { status: "rejected" as const }
        return { status: existing.status }
      }
      if (state.active >= 16 || notices.size >= 1024) return { status: "retryable" as const }
      const target = options.registry
        .targets(notice.accountID)
        .find((target) => target.deviceID === notice.deviceID && target.environment === options.environment)
      if (!target) return { status: "rejected" as const }
      const entry = {
        notice: structuredClone(notice),
        registrationID: target.registrationID,
        sessionID: target.sessionID,
        until: Date.now() + 10 * 60_000,
        status: "sending" as PushProvider.Result["status"] | "sending",
      }
      notices.set(notice.signalID, entry)
      state.active += 1
      try {
        const result = await options.provider.send(
          { token: target.token, signalID: notice.signalID, kind: notice.kind },
          () =>
            !state.stopped &&
            notices.get(notice.signalID) === entry &&
            options.authorized(notice) &&
            options.registry
              .targets(notice.accountID)
              .some(
                (current) => current.deviceID === target.deviceID && current.registrationID === target.registrationID,
              ),
        )
        entry.status = result.status
        if (result.status === "unregistered") options.registry.invalidate(target, result.timestamp)
        return { status: result.status }
      } catch {
        entry.status = "unknown"
        return { status: "unknown" as const }
      } finally {
        state.active -= 1
      }
    },
    get(accountID: string, deviceID: string, signalID: string) {
      prune()
      const entry = notices.get(signalID)
      if (
        !entry ||
        state.stopped ||
        entry.notice.accountID !== accountID ||
        entry.notice.deviceID !== deviceID ||
        !options.authorized(entry.notice)
      )
        return undefined
      if (
        !options.registry
          .targets(accountID)
          .some((target) => target.deviceID === deviceID && target.sessionID === entry.sessionID)
      )
        return undefined
      return structuredClone(entry.notice)
    },
    revoke(hostID: string, grantID: string) {
      for (const [id, entry] of notices)
        if (entry.notice.hostID === hostID && entry.notice.grantID === grantID) notices.delete(id)
    },
    stop() {
      state.stopped = true
      notices.clear()
    },
  }
}

function validate(notice: Notice) {
  for (const id of [notice.signalID, notice.hostID, notice.runtimeID, notice.grantID])
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new Error("Invalid push routing identity")
  if (!notice.accountID || notice.accountID.length > 128 || !/^[A-Za-z0-9_-]{87}$/.test(notice.deviceID))
    throw new Error("Invalid push device identity")
  if (!Number.isSafeInteger(notice.grantVersion) || notice.grantVersion < 1)
    throw new Error("Invalid push grant version")
  if (notice.kind !== "attention" && notice.kind !== "completed") throw new Error("Invalid push kind")
  if (!/^[A-Za-z0-9_-]{32,4096}$/.test(notice.context)) throw new Error("Invalid encrypted push context")
}
