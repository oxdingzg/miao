export * as RuntimeHost from "./host"

import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { InstallationVersion } from "@miao/core/installation/version"
import { createHash, randomBytes } from "node:crypto"
import type { RuntimeAdministration } from "@miao/core/runtime/administration"

export async function start(filename: string) {
  const owner = await RuntimeOwnership.acquireShared(filename)
  const credential = randomBytes(48).toString("hex")
  const identity = RuntimeIdentity.create(owner.storage, InstallationVersion, credential)
  // The listener uses a fresh environment-backed authentication layer.
  process.env.MIAO_SERVER_PASSWORD = credential
  process.env.MIAO_SERVER_USERNAME = "miao"
  const state: {
    server?: Awaited<ReturnType<(typeof import("@/server/server"))["Server"]["listen"]>>
    stopped: boolean
    agent?: { stop: () => Promise<void>; administration: RuntimeAdministration.Interface }
    execution?: { interruptAll: () => Promise<void>; dispose: () => Promise<void> }
    lifetime?: { stop: () => void }
  } = { stopped: false }
  const completion: { resolve?: () => void } = {}
  const closed = new Promise<void>((resolve) => {
    completion.resolve = resolve
  })
  const stop = async () => {
    if (state.stopped) return closed
    state.stopped = true
    const errors: unknown[] = []
    try {
      const actions = [
        () => state.lifetime?.stop(),
        () => state.agent?.stop(),
        () => (state.server ? state.execution?.interruptAll() : undefined),
        () => state.server?.stop(true),
        () => state.execution?.dispose(),
        async () => {
          const { AppRuntime } = await import("@/effect/app-runtime")
          await AppRuntime.dispose()
        },
        () => RuntimeDiscovery.remove(owner.storage, identity.runtimeID),
      ]
      for (const action of actions) {
        await Promise.resolve()
          .then(action)
          .catch((error: unknown) => {
            errors.push(error)
          })
      }
    } finally {
      owner.release()
      completion.resolve?.()
    }
    if (errors.length) throw new AggregateError(errors, "Runtime shutdown did not finish cleanly")
  }
  try {
    const { Effect, ManagedRuntime } = await import("effect")
    const { AppNodeBuilder } = await import("@miao/core/effect/app-node-builder")
    const { memoMap } = await import("@miao/core/effect/memo-map")
    const { SessionExecution } = await import("@miao/core/session/execution")
    const { SessionExecutionLocal } = await import("@miao/core/session/execution/local")
    const execution = ManagedRuntime.make(AppNodeBuilder.build(SessionExecutionLocal.node), { memoMap })
    state.execution = {
      interruptAll: () =>
        execution.runPromise(
          SessionExecution.Service.use((service) =>
            Effect.gen(function* () {
              const active = yield* service.active
              yield* Effect.forEach(active, (sessionID) => service.interrupt(sessionID), { discard: true })
            }),
          ),
        ),
      dispose: () => execution.dispose(),
    }
    const { Server } = await import("@/server/server")
    state.server = await Server.listen({
      hostname: "127.0.0.1",
      port: 0,
      mdns: false,
      cors: [],
      runtime: {
        administration: () => (state.stopped ? undefined : state.agent?.administration),
        prove: identity.prove,
        stop: () => {
          setTimeout(() => {
            void stop().catch(console.error)
          }, 100)
        },
      },
    })
    identity.bind(state.server.url.href)
    const { RuntimeControlAgent } = await import("./control-agent")
    state.agent = await RuntimeControlAgent.start({
      url: state.server.url.href,
      credential,
      runtimeID: identity.runtimeID,
      storage: owner.storage,
    })
    const record: RuntimeDiscovery.Record = {
      url: state.server.url.href,
      runtimeID: identity.runtimeID,
      version: identity.version,
      protocol: identity.protocol,
      storageID: identity.storageID,
      credential,
      configurationID: createHash("sha256")
        .update(process.env.MIAO_CONFIG_CONTENT ?? "")
        .digest("hex"),
    }
    await RuntimeDiscovery.publish(owner.storage, record)
    // A background daemon shared by every window must not linger once nothing
    // needs it (`specs/runtime-lifetime.md`). While the activity vector is empty
    // a countdown is armed; new activity cancels it.
    const { RuntimeLifetime } = await import("./lifetime")
    const linger = RuntimeLifetime.lingerMs()
    if (linger >= 0) {
      const pinsRemoteControl = RuntimeLifetime.remoteControlPins()
      const { AppRuntime } = await import("@/effect/app-runtime")
      const { RuntimeActivity } = await import("@miao/core/runtime/activity")
      const startupGrace = RuntimeLifetime.startupGraceMs()
      const startedAt = Date.now()
      let everActive = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let checking = false
      const idle = async () => {
        if (state.stopped) return false
        const connections = state.server ? await state.server.connected() : 0
        if (connections > 0) return false
        const remote = pinsRemoteControl ? state.agent?.administration.status() : undefined
        if (remote?.enabled && remote.connected) return false
        const snapshot = await AppRuntime.runPromise(RuntimeActivity.Service.use((activity) => activity.snapshot))
        return (
          snapshot.executions === 0 && snapshot.unpromoted === 0 && snapshot.scheduled === 0 && snapshot.background === 0
        )
      }
      const drain = () => {
        timer = undefined
        void (async () => {
          // Re-evaluate at the instant the countdown fires; resumed activity
          // re-arms rather than shutting down.
          if (!(await idle())) return
          await stop().catch(() => undefined)
        })()
      }
      const tick = () => {
        if (checking || state.stopped) return
        checking = true
        void idle()
          .then((empty) => {
            if (!empty) {
              // Seen activity: from now on an empty vector means the last client left.
              everActive = true
              if (timer !== undefined) {
                clearTimeout(timer)
                timer = undefined
              }
              return
            }
            // A just-spawned Runtime has no client yet; give the starting client
            // the startup grace before treating an empty vector as idle.
            if (!everActive && Date.now() - startedAt < startupGrace) return
            if (timer === undefined) timer = setTimeout(drain, linger)
          })
          .catch(() => undefined)
          .finally(() => {
            checking = false
          })
      }
      const interval = setInterval(tick, 1000)
      state.lifetime = {
        stop: () => {
          clearInterval(interval)
          if (timer !== undefined) clearTimeout(timer)
        },
      }
      tick()
    }
    return { record, stop, closed }
  } catch (error) {
    await stop().catch(console.error)
    throw error
  }
}
