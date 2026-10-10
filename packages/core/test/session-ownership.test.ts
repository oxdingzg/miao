import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { symlink } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { LocationServiceMap } from "../src/location-services"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionOwnership } from "../src/session/ownership"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { tmpdir } from "./fixture/tmpdir"

async function window(storage: string, id: string, action = "prompt") {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Effect } from "effect";
       import { AppNodeBuilder } from "@miao/core/effect/app-node-builder";
       import { Database } from "@miao/core/database/database";
       import { SessionV2 } from "@miao/core/session";
       import { SessionExecution } from "@miao/core/session/execution";
       const layer = AppNodeBuilder.build(SessionV2.node, [
         [Database.node, Database.sharedLayerFromPath(${JSON.stringify(storage)})],
         [SessionExecution.node, SessionExecution.noopLayer],
       ]);
       await Effect.runPromise(Effect.gen(function* () {
         const sessions = yield* SessionV2.Service;
         const session = yield* sessions.create({ id: SessionV2.ID.make(${JSON.stringify(id)}), location: { directory: ${JSON.stringify(path.dirname(storage))} } });
         if (${JSON.stringify(action)} === "prompt")
           yield* sessions.prompt({ sessionID: session.id, prompt: { text: "durable input" }, resume: false });
         if (${JSON.stringify(action)} === "rename")
           yield* sessions.rename({ sessionID: session.id, title: "renamed" });
         if (${JSON.stringify(action)} === "stress")
           for (let index = 0; index < 40; index++)
             yield* sessions.prompt({ sessionID: session.id, prompt: { text: "input " + index }, resume: false });
         const pending = yield* sessions.inputs({ sessionID: session.id, limit: 100 });
         const history = yield* sessions.history({ sessionID: session.id, limit: 100 });
         const messages = yield* sessions.messages({ sessionID: session.id });
         console.log(JSON.stringify({ ready: true, pending: pending.inputs.length, messages: messages.length, sequences: history.events.map((event) => event.durable.seq) }));
         yield* Effect.never;
       }).pipe(Effect.provide(layer), Effect.scoped));`,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, MIAO_PRINT_LOGS: "0" } },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const timer = setTimeout(() => void reader.cancel(), 20_000)
  let ready = ""
  try {
    while (!ready.includes("\n")) {
      const output = await reader.read()
      if (output.done) break
      ready += decoder.decode(output.value, { stream: true })
    }
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  if (!ready.includes('"ready":true')) {
    child.kill()
    await child.exited
    throw new Error((await new Response(child.stderr).text()) || `Window readiness failed: ${ready}`)
  }
  return {
    child,
    ready,
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null) child.kill()
      await child.exited
    },
  }
}

test("claims are idempotent and held until their runtime scope closes", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "leases.db")
  const scope = Scope.makeUnsafe()
  const owner = await Effect.runPromise(SessionOwnership.make(storage).pipe(Effect.provideService(Scope.Scope, scope)))
  const id = SessionSchema.ID.create()
  await Effect.runPromise(Effect.all([owner.claim(id), owner.claim(id)], { concurrency: "unbounded" }))
  expect(await Effect.runPromise(owner.owned(id))).toBe(true)
  await Scope.close(scope, Exit.void).pipe(Effect.runPromise)
  expect(await Effect.runPromise(owner.owned(id))).toBe(false)
  await expect(Effect.runPromise(owner.claim(id))).rejects.toThrow("closing")
}, 30_000)

test("another window can read a session but cannot admit input or change its metadata", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "sessions.db")
  const id = SessionSchema.ID.create()
  await using first = await window(storage, id)
  await using reader = await window(storage, id, "read")
  try {
    expect(reader.ready).toContain('"pending":1')
    expect(reader.ready).toContain('"messages":0')
    await expect(window(storage, id)).rejects.toThrow("another miao window")
    await expect(window(storage, id, "rename")).rejects.toThrow("another miao window")
  } finally {
    first.child.kill()
    reader.child.kill()
    await Promise.all([first.child.exited, reader.child.exited])
  }
}, 30_000)

test("different sessions run independently and one window's death leaves the other owned", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "parallel.db")
  const firstID = SessionSchema.ID.create()
  const secondID = SessionSchema.ID.create()
  await using first = await window(storage, firstID)
  await using second = await window(storage, secondID)
  first.child.kill("SIGKILL")
  await first.child.exited
  await using adopted = await window(storage, firstID, "rename")
  try {
    expect(adopted.ready).toContain('"pending":1')
    expect(adopted.ready).toContain('"messages":0')
    await expect(window(storage, secondID, "rename")).rejects.toThrow("another miao window")
  } finally {
    adopted.child.kill()
    second.child.kill()
    await Promise.all([adopted.child.exited, second.child.exited])
  }
}, 30_000)

test("a paused owner is never stolen through a storage path alias", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "paused.db")
  const id = SessionSchema.ID.create()
  await using first = await window(storage, id)
  await symlink(tmp.path, path.join(tmp.path, "alias"))
  first.child.kill("SIGSTOP")
  try {
    await expect(window(path.join(tmp.path, "alias", "paused.db"), id, "rename")).rejects.toThrow("another miao window")
  } finally {
    first.child.kill("SIGKILL")
    await first.child.exited
  }
}, 30_000)

test("different windows concurrently admit inputs without WAL snapshot failures or sequence gaps", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "writes.db")
  const results = await Promise.allSettled([
    window(storage, SessionSchema.ID.create(), "stress"),
    window(storage, SessionSchema.ID.create(), "stress"),
  ])
  const windows = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  try {
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Concurrent window startup failed")
    windows.forEach((entry) => {
      expect(entry.ready).toContain('"pending":40')
      const output = JSON.parse(entry.ready)
      expect(output.sequences).toEqual(Array.from({ length: 41 }, (_, index) => index))
    })
  } finally {
    windows.forEach((entry) => entry.child.kill())
    await Promise.all(windows.map((entry) => entry.child.exited))
  }
}, 30_000)

test("a wakeup for a session owned by another window is advisory, not a conflict", async () => {
  await using tmp = await tmpdir()
  const storage = path.join(tmp.path, "wake.db")
  const id = SessionSchema.ID.create()
  await using owner = await window(storage, id)
  try {
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, LocationServiceMap.node, SessionStore.node, SessionExecution.node]),
      [
        [Database.node, Database.sharedLayerFromPath(storage)],
        [SessionExecution.node, SessionExecutionLocal.node],
      ],
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        // The owner window holds the lease, so this runtime cannot claim the
        // Session. A send_message wakeup must stay advisory instead of raising
        // SessionOwnership.BusyError; the durable input waits for its window.
        yield* execution.wake(SessionSchema.ID.make(id))
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  } finally {
    owner.child.kill()
    await owner.child.exited
  }
}, 30_000)
