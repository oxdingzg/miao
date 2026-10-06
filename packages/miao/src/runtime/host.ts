export * as RuntimeHost from "./host"

import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { WindowLifecycle } from "./lifecycle"
import { RuntimeRegistration } from "@miao/core/runtime/registration"
import { InstallationVersion } from "@miao/core/installation/version"
import { createHash, randomBytes } from "node:crypto"
import type { RuntimeAdministration } from "@miao/core/runtime/administration"

export async function start(filename: string) {
  const storage = await RuntimeOwnership.canonicalStorage(filename)
  const credential = randomBytes(48).toString("hex")
  const identity = RuntimeIdentity.create(storage, InstallationVersion, credential)
  // The listener uses a fresh environment-backed authentication layer.
  process.env.MIAO_SERVER_PASSWORD = credential
  process.env.MIAO_SERVER_USERNAME = "miao"
  type Agent = { stop: () => Promise<void>; administration: RuntimeAdministration.Interface }
  const state: {
    server?: Awaited<ReturnType<(typeof import("@/server/server"))["Server"]["listen"]>>
    stopped: boolean
    agent?: Agent
    execution?: { interruptAll: () => Promise<void>; dispose: () => Promise<void> }
    agentStarting?: Promise<Agent | undefined>
  } = { stopped: false }
  const initialization: { resolve?: () => void } = {}
  const initialized = new Promise<void>((resolve) => {
    initialization.resolve = resolve
  })
  const completion: { resolve?: () => void } = {}
  const closed = new Promise<void>((resolve) => {
    completion.resolve = resolve
  })
  const stop = async () => {
    if (state.stopped) return closed
    state.stopped = true
    await initialized
    const errors: unknown[] = []
    try {
      const actions = [
        async () => {
          await state.agentStarting
        },
        () => state.agent?.stop(),
        () => state.server?.stop(true),
        () => (state.server ? state.execution?.interruptAll() : undefined),
        () => state.execution?.dispose(),
        () => WindowLifecycle.disposeCore(),
        () => RuntimeRegistration.remove(storage, identity.runtimeID),
      ]
      for (const action of actions) {
        await Promise.resolve()
          .then(action)
          .catch((error: unknown) => {
            errors.push(error)
          })
      }
    } finally {
      unregister()
      completion.resolve?.()
    }
    if (errors.length) throw new AggregateError(errors, "Runtime shutdown did not finish cleanly")
  }
  const unregister = WindowLifecycle.register(stop)
  try {
    const { Effect, ManagedRuntime } = await import("effect")
    const { AppNodeBuilder } = await import("@miao/core/effect/app-node-builder")
    const { memoMap } = await import("@miao/core/effect/memo-map")
    const { SessionExecution } = await import("@miao/core/session/execution")
    const { SessionExecutionLocal } = await import("@miao/core/session/execution/local")
    const { Database } = await import("@miao/core/database/database")
    const { EventV2 } = await import("@miao/core/event")
    const { SessionOwnership } = await import("@miao/core/session/ownership")
    const { LayerNode } = await import("@miao/core/effect/layer-node")
    const execution = ManagedRuntime.make(
      AppNodeBuilder.build(
        LayerNode.group([SessionExecutionLocal.node, EventV2.node, SessionOwnership.node, Database.node]),
      ),
      { memoMap },
    )
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
        administration: async () => {
          if (state.stopped) return undefined
          state.agentStarting ??= (async () => {
            const { RuntimeControlAgent } = await import("@miao/sdk/remote-control/control-agent")
            const agent = await RuntimeControlAgent.start({
              url: state.server!.url.href,
              run: (effect) => execution.runPromise(effect),
              credential,
              runtimeID: identity.runtimeID,
              storage,
            })
            state.agent = agent
            return agent
          })()
          return (await state.agentStarting)?.administration
        },
        prove: identity.prove,
        stop: () => {
          setTimeout(() => {
            void stop().catch(console.error)
          }, 100)
        },
      },
    })
    if (state.stopped) throw new Error("This miao window is closing")
    identity.bind(state.server.url.href)
    const record: RuntimeRegistration.Record = {
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
    await RuntimeRegistration.publish(storage, record)
    return { record, stop, closed }
  } catch (error) {
    initialization.resolve?.()
    await stop().catch(console.error)
    throw error
  } finally {
    initialization.resolve?.()
  }
}
