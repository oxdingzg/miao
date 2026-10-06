import "@miao/core/flag/legacy-env"
import { Crash } from "@/cli/crash"
import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { Monitor } from "@/cli/monitor"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

Heap.start()
Monitor.start()

// The server thread swallows these so one rejected promise cannot take the
// worker down, but swallowing silently makes a flash exit undebuggable. Record
// it first; the process keeps running exactly as before.
const onUnhandledRejection = (error: unknown) => {
  Crash.recordCrash("unhandledRejection", error)
}

const onUncaughtException = (error: Error) => {
  Crash.recordCrash("uncaughtException", error)
}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let runtime: Awaited<ReturnType<(typeof import("@/runtime/host"))["RuntimeHost"]["start"]>> | undefined

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async runtime() {
    const { RuntimeHost } = await import("@/runtime/host")
    const { DatabaseFile } = await import("@miao/core/database/file")
    runtime = await RuntimeHost.start(DatabaseFile.path())
    return runtime.record
  },
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await runtime?.stop()
    if (server) await server.stop(true)
    const { WindowLifecycle } = await import("@/runtime/lifecycle")
    await WindowLifecycle.disposeCore()
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
