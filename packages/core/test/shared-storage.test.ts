import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Database } from "../src/database/database"
import { migrations } from "../src/database/migration.gen"
import { RuntimeOwnership } from "../src/runtime/ownership"
import { tmpdir } from "./fixture/tmpdir"

async function window(filename: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Database } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/database/database.ts"))};
       import { Effect } from "effect";
       await Effect.runPromise(Effect.gen(function* () {
         yield* Database.Service;
         console.log("ready");
         yield* Effect.never;
       }).pipe(Effect.provide(Database.sharedLayerFromPath(${JSON.stringify(filename)})), Effect.scoped));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const ready = await child.stdout.getReader().read()
  if (!new TextDecoder().decode(ready.value).includes("ready")) {
    child.kill()
    await child.exited
    throw new Error(await new Response(child.stderr).text())
  }
  return child
}

test("exclusive storage ownership fails shared startup within its retry budget", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "exclusive.db")
  const owner = await RuntimeOwnership.acquire(filename)
  try {
    const started = Date.now()
    await expect(
      Effect.runPromise(Database.Service.pipe(Effect.provide(Database.sharedLayerFromPath(filename)), Effect.scoped)),
    ).rejects.toThrow("close its windows")
    expect(Date.now() - started).toBeLessThan(10_000)
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
  } finally {
    owner.release()
  }
}, 15_000)

test("independent windows share migrated storage and block exclusive maintenance", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "shared.db")
  const first = await window(filename)
  const second = await window(filename)
  try {
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
    first.kill("SIGKILL")
    await first.exited
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
    second.kill("SIGKILL")
    await second.exited
    const owner = await RuntimeOwnership.acquire(filename)
    owner.release()
  } finally {
    first.kill()
    second.kill()
    await Promise.all([first.exited, second.exited])
  }
}, 15_000)

test("pending migrations wait for another window instead of touching its database", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "migration.db")
  const first = await window(filename)
  const sqlite = await import("bun:sqlite")
  const native = new sqlite.Database(filename)
  let settled = false
  try {
    // The window holds the runtime lock before anything touches the schema.
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
    // Strip the whole schema (tables and journal) while the window runs: the
    // upgrade then has a genuinely pending build to apply, and the running
    // window is what keeps it from starting.
    const tables = native
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    for (const table of tables) native.exec(`DROP TABLE "${table.name}"`)
    const pending = Effect.runPromise(
      Database.Service.pipe(Effect.provide(Database.sharedLayerFromPath(filename)), Effect.scoped),
    ).then(
      (database) => {
        settled = true
        return database
      },
      (error) => {
        settled = true
        throw error
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    // The rebuild must still be waiting, not failed or applied: the window is
    // alive.
    expect(settled).toBe(false)
    // Quitting the old window lets the wait finish and the upgrade apply.
    first.kill()
    await first.exited
    const database = await pending
    expect(database.db).toBeDefined()
  } finally {
    native.close()
  }
}, 20_000)

test("a shared user cannot acquire exclusive access until other processes close", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "maintenance.db")
  const child = await window(filename)
  const usage = await RuntimeOwnership.use(filename)
  try {
    expect(() => usage.exclusive()).toThrow("Close other miao windows")
    child.kill("SIGKILL")
    await child.exited
    // A failed upgrade leaves no active transaction; close before reacquiring.
  } finally {
    usage.release()
    child.kill()
    await child.exited
  }
  const owner = await RuntimeOwnership.use(filename)
  owner.exclusive()
  owner.share()
  owner.release()
}, 15_000)

test("simultaneous first openers initialize one database and retain independent readers", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "initial.db")
  const children = await Promise.all([window(filename), window(filename)])
  try {
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
  } finally {
    children.forEach((child) => child.kill())
    await Promise.all(children.map((child) => child.exited))
  }
}, 15_000)

test("failed exclusive acquisition cannot release another in-process reader", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "scopes.db")
  const first = await RuntimeOwnership.use(filename)
  first.share()
  const second = await RuntimeOwnership.use(filename)
  try {
    expect(() => second.exclusive()).toThrow("Close other miao windows")
    second.release()
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
  } finally {
    first.release()
    second.release()
  }
  const owner = await RuntimeOwnership.acquire(filename)
  owner.release()
})
