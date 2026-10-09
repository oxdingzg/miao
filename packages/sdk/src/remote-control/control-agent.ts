export * as RuntimeControlAgent from "./control-agent"

import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { EventV2 } from "@miao/core/event"
import { RuntimeControlLive } from "./control-live"
import { OpenCode } from "@miao/client"
import { DeviceGrants } from "@miao/remote-control/grants"
import { ControlAgent } from "@miao/remote-control/agent"
import { ControlPairing } from "@miao/remote-control/pairing"
import { PushSender } from "@miao/remote-control/push-sender"
import { RemoteAccess } from "@miao/schema/remote-access"
import type { RuntimeAdministration } from "@miao/core/runtime/administration"
import { RuntimeControlMethods } from "./control-methods"
import { Database } from "@miao/core/database/database"
import { Session } from "@miao/schema/session"
import { SessionOwnership } from "@miao/core/session/ownership"
import { ServerAuth } from "@miao/server/auth"

const Configuration = Schema.Struct({
  accountID: RemoteAccess.Configuration.fields.accountID,
  hubURL: Schema.String,
  hostToken: Schema.String.check(Schema.isMinLength(32)),
  grantFile: Schema.String.check(Schema.isMinLength(1)),
  allowLoopbackHTTP: Schema.optional(Schema.Boolean),
})

/** Owner-only configuration, never received through the remote RPC channel. */
export async function start(input: {
  url: string
  run: <A, E>(effect: Effect.Effect<A, E, Database.Service | EventV2.Service | SessionOwnership.Service>) => Promise<A>
  username?: string
  credential: string
  runtimeID: string
  storage?: string
  allowLoopbackHTTP?: boolean
}) {
  const filename =
    process.env.MIAO_REMOTE_CONTROL_CONFIG ??
    (input.storage ? path.join(input.storage + ".remote-control", "control.json") : undefined)
  if (!filename) return undefined
  const initial = await readConfiguration(filename)
  const grantFile = initial?.grantFile ?? "devices.json"
  const grants = await DeviceGrants.load(path.resolve(path.dirname(filename), grantFile))
  const client = OpenCode.make({
    baseUrl: input.url,
    headers: ServerAuth.headers({ username: input.username ?? "miao", password: input.credential }),
  })
  const state: {
    stopped: boolean
    tail: Promise<unknown>
    unsubscribe?: Effect.Effect<void>
    active?: {
      agent: ReturnType<typeof ControlAgent.connect>
      pairing: ReturnType<typeof ControlPairing.make>
      configuration: typeof Configuration.Type
      notifications: ReturnType<typeof PushSender.make>
    }
  } = { stopped: false, tail: Promise.resolve() }
  const published = new Set<string>()
  const live = RuntimeControlLive.make()
  const allowLoopbackHTTP = input.allowLoopbackHTTP ?? initial?.allowLoopbackHTTP ?? false
  const owned = (sessionID: string) =>
    input.run(SessionOwnership.Service.use((ownership) => ownership.owned(sessionID)))
  const accessible = async (sessionID: string) => (await owned(sessionID)) && published.has(sessionID)
  const publish = async (sessionID: string) => {
    const session = await client.sessions.get({ sessionID })
    await input.run(
      SessionOwnership.Service.use((ownership) => ownership.claim(Schema.decodeUnknownSync(Session.ID)(session.id))),
    )
    if (state.stopped) throw new Error("Remote Control stopped")
    published.add(sessionID)
  }
  const projectForSession = async (sessionID: string, signal?: AbortSignal) =>
    (await accessible(sessionID))
      ? (await client.sessions.get({ sessionID }, { signal }).catch(() => undefined))?.projectID
      : undefined
  const activate = async (configuration: typeof Configuration.Type) => {
    state.unsubscribe = await input.run(
      EventV2.Service.use((events) =>
        events.listen((event) =>
          Effect.sync(() => {
            live.accept(event)
            state.active?.notifications.accept(event)
          }),
        ),
      ),
    )
    const pairing = ControlPairing.make({
      grants,
      target: { hostID: grants.hostID, runtimeID: input.runtimeID },
      hubURL: configuration.hubURL,
    })
    const agent = ControlAgent.connect({
      hubURL: configuration.hubURL,
      accountID: configuration.accountID,
      hostToken: configuration.hostToken,
      allowLoopbackHTTP: configuration.allowLoopbackHTTP,
      runtimeID: input.runtimeID,
      grants,
      pairing,
      methods: RuntimeControlMethods.make({ client, live, owned: accessible, sessionCreated: publish, run: input.run }),
      sessionEnabled: (sessionID) => published.has(sessionID),
      projectForSession,
    })
    const notifications = PushSender.make({
      hubURL: configuration.hubURL,
      hostToken: configuration.hostToken,
      runtimeID: input.runtimeID,
      grants,
      connected: () => agent.connected(),
      sessionEnabled: (sessionID) => published.has(sessionID),
      allowLoopbackHTTP: configuration.allowLoopbackHTTP,
      projectForSession,
    })
    state.active = { agent, pairing, configuration, notifications }
  }
  const status = (): RemoteAccess.Status => ({
    accountID: state.active?.configuration.accountID,
    sessionIDs: [...published],
    enabled: !state.stopped && state.active !== undefined,
    connected: !state.stopped && (state.active?.agent.connected() ?? false),
    hostID: grants.hostID,
    runtimeID: input.runtimeID,
    hostPublicKey: grants.identity.publicKey,
    ...(state.active ? { hubURL: state.active.configuration.hubURL } : {}),
  })
  const disconnect = async () => {
    const active = state.active
    state.active = undefined
    active?.agent.stop()
    await active?.notifications.stop()
    await active?.pairing.stop()
    const unsubscribe = state.unsubscribe
    state.unsubscribe = undefined
    if (unsubscribe) await input.run(unsubscribe)
    live.clear()
  }
  const accountTrust = (): RemoteAccess.AccountTrustStatus | null => {
    const saved = grants.accountTrust()
    return saved
      ? {
          hubURL: saved.hubURL,
          accountID: saved.accountID,
          acceptedSequence: saved.acceptedSequence,
          deviceCount: saved.devices.length,
          permissions: saved.policy.permissions,
          expiresAt: saved.policy.expiresAt,
          autoAdmit: saved.policy.autoAdmit,
        }
      : null
  }
  const administration: RuntimeAdministration.Interface = {
    status,
    accountTrust,
    bindAccount: (grantID, version, policy) => {
      const operation = state.tail.then(async () => {
        if (state.stopped || !state.active?.configuration.accountID)
          throw new Error("Authenticated Hub account required")
        const configuration = state.active.configuration
        const projects = await client.projects.list()
        if (policy.projectIDs.some((id) => !projects.data.some((project) => project.id === id)))
          throw new Error("Unknown project scope")
        if ((await Promise.all(policy.sessionIDs.map(owned))).some((valid) => !valid))
          throw new Error("Session unavailable in this Runtime")
        if (state.stopped) throw new Error("Remote Control stopped")
        await grants.bindAccount({
          hubURL: configuration.hubURL,
          accountID: configuration.accountID!,
          grantID,
          grantVersion: version,
          policy,
          allowLoopbackHTTP,
        })
        return accountTrust()!
      })
      state.tail = operation.catch(() => undefined)
      return operation
    },
    clearAccountTrust: () => {
      const operation = state.tail.then(async () => {
        if (state.stopped) throw new Error("Remote Control stopped")
        const revoked = await grants.clearAccountTrust()
        const active = state.active
        for (const grant of revoked) {
          await active?.agent.revoke(grant.id, grant.version)
          await active?.notifications.revoke(grant)
        }
      })
      state.tail = operation.catch(() => undefined)
      return operation
    },
    setSessionEnabled: (sessionID, enabled) => {
      const operation = state.tail.then(async () => {
        if (state.stopped) throw new Error("Remote Control stopped")
        if (enabled) await publish(sessionID)
        if (!enabled) published.delete(sessionID)
        return status()
      })
      state.tail = operation.catch(() => undefined)
      return operation
    },
    setEnabled: (enabled) => {
      const operation = state.tail.then(async () => {
        if (state.stopped) throw new Error("Remote Control stopped")
        if (!enabled) {
          await disconnect()
          return status()
        }
        if (state.active) return status()
        const configuration = await readConfiguration(filename)
        if (configuration) await activate(configuration)
        return status()
      })
      state.tail = operation.catch(() => undefined)
      return operation
    },
    configure: (payload) => {
      const operation = state.tail.then(async () => {
        if (state.stopped) throw new Error("Remote Control stopped")
        const decoded = Schema.decodeUnknownSync(RemoteAccess.Configuration, { onExcessProperty: "error" })(payload)
        const url = new URL(decoded.hubURL)
        const local =
          allowLoopbackHTTP && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        if (
          (!local && url.protocol !== "https:") ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new Error("Invalid relay origin")
        const configuration = {
          ...(decoded.accountID ? { accountID: decoded.accountID } : {}),
          hubURL: url.origin,
          hostToken: decoded.hostToken,
          grantFile,
          ...(allowLoopbackHTTP ? { allowLoopbackHTTP: true } : {}),
        }
        await saveConfiguration(filename, configuration)
        if (state.stopped) throw new Error("Remote Control stopped")
        await disconnect()
        await activate(configuration)
        return status()
      })
      state.tail = operation.catch(() => undefined)
      return operation
    },
    invite: async (policy) => {
      if (state.stopped || !state.active) throw new Error("Remote Control stopped")
      const projects = await client.projects.list()
      if (policy.projectIDs.some((id) => !projects.data.some((project) => project.id === id)))
        throw new Error("Unknown project scope")
      for (const sessionID of policy.sessionIDs) await publish(sessionID)
      if (state.stopped || !state.active) throw new Error("Remote Control stopped")
      return state.active.pairing.issue(policy)
    },
    pending: () => state.active?.pairing.list() ?? [],
    approve: (pairingID, publicKey) => {
      if (!state.active || state.stopped) return Promise.reject(new Error("Remote Control stopped"))
      return state.active.pairing.approve(pairingID, publicKey)
    },
    reject: (pairingID) => state.active?.pairing.reject(pairingID),
    devices: () => grants.list(),
    revoke: async (grantID, version) => {
      const active = state.active
      const result = active ? await active.agent.revoke(grantID, version) : await grants.revoke(grantID, version)
      await active?.notifications.revoke(result)
      return result
    },
  }
  return {
    administration,
    stop: async () => {
      if (state.stopped) return
      state.stopped = true
      await state.tail
      await disconnect()
      published.clear()
      await grants.close()
    },
  }
}

async function readConfiguration(filename: string) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Remote Control configuration must be a private owner-readable file")
    const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Configuration)), {
      onExcessProperty: "error",
    })(await file.readFile("utf8"))
    if (Option.isNone(decoded)) throw new Error("Invalid Remote Control configuration")
    return decoded.value
  } finally {
    await file.close()
  }
}

async function saveConfiguration(filename: string, configuration: typeof Configuration.Type) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const directory = await lstat(path.dirname(filename))
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))
  )
    throw new Error("Relay configuration directory must be private")
  // Reject an existing unsafe target rather than overwriting somebody else's configuration.
  await readConfiguration(filename)
  const temporary = filename + "." + crypto.randomUUID() + ".tmp"
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await file.writeFile(JSON.stringify(configuration))
    await file.sync()
    await file.close()
    await rename(temporary, filename)
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
