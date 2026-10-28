import { expect, test } from "bun:test"
import path from "node:path"
import readline from "node:readline"
import { Readable } from "node:stream"
import { tmpdir } from "../fixture/fixture"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { Location } from "@miao/schema/location"
import { connectEngine } from "@/engine/connection"

test("a failed project tool import is diagnosed without losing healthy worker tools", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".miao", "tool")
  await Bun.write(
    path.join(directory, "healthy.js"),
    'export default { description: "Healthy fixture", args: {}, async execute() { return "healthy result" } }',
  )
  await Bun.write(
    path.join(directory, "broken.js"),
    'import "miao-intentionally-missing-worker-dependency"; export default {}',
  )
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/engine/worker-host.ts")], {
    cwd: tmp.path,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const output = Readable.from(
    (async function* () {
      const reader = child.stdout.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          yield chunk.value
        }
      } finally {
        reader.releaseLock()
      }
    })(),
  )
  const lines = readline.createInterface({ input: output, terminal: false })
  const iterator = lines[Symbol.asyncIterator]()
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    for (const command of [
      { id: 1, method: "hello", params: { workspace: tmp.path }, result: { protocol: 2 } },
      {
        id: 2,
        method: "tool.list",
        params: {},
        result: { tools: [{ name: "healthy", description: "Healthy fixture" }] },
      },
      { id: 3, method: "tool.call", params: { name: "healthy", input: {} }, result: { result: "healthy result" } },
      { id: 4, method: "shutdown", params: {}, result: {} },
    ]) {
      child.stdin.write(JSON.stringify({ id: command.id, method: command.method, params: command.params }) + "\n")
      const line = await iterator.next()
      expect(line.done).toBe(false)
      const frame: unknown = JSON.parse(line.value ?? "")
      expect(frame).toMatchObject({ id: command.id, result: command.result })
    }
    expect(await child.exited).toBe(0)
    const diagnostic = await stderr
    expect(diagnostic).toContain("[worker-host]")
    expect(diagnostic).toContain("broken.js")
    expect(diagnostic).toContain("miao-intentionally-missing-worker-dependency")
  } finally {
    clearTimeout(timer)
    lines.close()
    output.destroy()
    if (child.exitCode === null) child.kill()
    await child.exited
    await stderr
  }
}, 25_000)

const binary = process.env.MIAO_ENGINE_BIN

for (const failure of ["import", "missing", "flood"] as const) {
  test.skipIf(!binary)(
    `native worker ${failure} errors reach the product connection while its engine remains usable`,
    async () => {
      await using tmp = await tmpdir()
      const workspace = path.join(tmp.path, "workspace")
      await Promise.all(
        Array.from({ length: failure === "flood" ? 32 : 1 }, (_, index) =>
          Bun.write(
            path.join(
              workspace,
              ".miao",
              "tool",
              failure === "flood" ? `broken-${String(index).padStart(2, "0")}.js` : "broken.js",
            ),
            'import "miao-intentionally-missing-worker-dependency"; export default {}',
          ),
        ),
      )
      const config = path.join(tmp.path, "worker.json")
      await Bun.write(
        config,
        JSON.stringify({
          argv:
            failure !== "missing"
              ? [process.execPath, path.resolve(import.meta.dir, "../../src/engine/worker-host.ts")]
              : [path.join(tmp.path, "missing-worker")],
        }),
      )
      const diagnostics: string[] = []
      const reported = Promise.withResolvers<void>()
      await Effect.runPromise(
        Effect.gen(function* () {
          const connection = yield* connectEngine({
            binary: binary!,
            db: path.join(tmp.path, "engine.db"),
            workspace,
            model: "fixture",
            provider: "openai-chat",
            engineID: "worker-diagnostics",
            location: Schema.decodeUnknownSync(Location.Ref)({ directory: workspace }),
            workerConfigFile: config,
            env: { OPENAI_API_KEY: "fixture-only" },
            onDiagnostic: (message) => {
              diagnostics.push(message)
              if (failure === "flood" && diagnostics.length === 1) throw new Error("fixture observer failed")
              if (failure !== "flood" || message.includes("further diagnostics omitted")) reported.resolve()
            },
          })
          expect(
            yield* Effect.promise(() => connection.client.request("events", { session_id: "s", after: 0 })),
          ).toEqual([])
          yield* Effect.promise(() =>
            Promise.race([
              reported.promise,
              Bun.sleep(10_000).then(() => {
                throw new Error("worker diagnostic did not reach the native connection")
              }),
            ]),
          )
          yield* connection.flush
          expect(diagnostics).toHaveLength(failure === "flood" ? 17 : 1)
          expect(diagnostics[0]).toContain(
            failure === "missing" ? "worker could not start" : failure === "flood" ? "broken-00.js" : "broken.js",
          )
          expect(diagnostics[0]).toContain(
            failure !== "missing" ? "miao-intentionally-missing-worker-dependency" : "built-in tools remain available",
          )
          expect(connection.client.stderrText).toContain(
            failure !== "missing" ? "[worker-host]" : "extension worker unavailable",
          )
          if (failure === "flood") {
            expect(diagnostics[16]).toContain("further diagnostics omitted")
            expect(diagnostics.every((message) => message.length <= 8192)).toBe(true)
          }
          expect(connection.client.available).toBe(true)
        }).pipe(Effect.provide(AppNodeBuilder.build(ClientEvents.node)), Effect.scoped),
      )
    },
    25_000,
  )
}
