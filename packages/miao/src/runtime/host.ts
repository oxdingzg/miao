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
  // The listener uses a fresh environment-backed auth layer. Router clients receive
  // the explicit credential rather than relying on earlier Flag snapshots.
  process.env.MIAO_SERVER_PASSWORD = credential
  process.env.MIAO_SERVER_USERNAME = "miao"
  const state: {
    server?: Awaited<ReturnType<(typeof import("@/server/server"))["Server"]["listen"]>>
    im?: Awaited<ReturnType<(typeof import("@/cli/cmd/remote"))["prepareRuntimeIM"]>>
    stopped: boolean
    agent?: { stop: () => Promise<void>; administration: RuntimeAdministration.Interface }
    execution?: { interruptAll: () => Promise<void>; dispose: () => Promise<void> }
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
        () => state.agent?.stop(),
        () => state.im?.stop(),
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
    const { prepareRuntimeIM } = await import("@/cli/cmd/remote")
    state.im = await prepareRuntimeIM(credential)
    const { Server } = await import("@/server/server")
    state.server = await Server.listen({
      hostname: "127.0.0.1",
      port: state.im.port,
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
      remote: state.im.control,
    })
    identity.bind(state.server.url.href)
    const { RuntimeControlAgent } = await import("./control-agent")
    state.agent = await RuntimeControlAgent.start({
      url: state.server.url.href,
      credential,
      runtimeID: identity.runtimeID,
      storage: owner.storage,
    })
    await state.im.start(state.server.url)
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
    return { record, stop, closed }
  } catch (error) {
    await stop().catch(console.error)
    throw error
  }
}
