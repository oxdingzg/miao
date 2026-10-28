import { expect, test } from "bun:test"
import path from "node:path"
import { chmod, copyFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { FSUtil } from "@miao/core/fs-util"
import { WorkerConfig } from "@/engine/worker-config"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(FSUtil.node))
const Manifest = Schema.Struct({ argv: Schema.Array(Schema.String) })

async function verifyWorker(argv: readonly string[], workspace: string, env = process.env) {
  await Bun.write(
    path.join(workspace, ".miao", "tool", "fixture.js"),
    'export default { description: "Worker fixture", args: {}, async execute(_args, context) { return "worker in " + context.directory } }',
  )
  const child = Bun.spawn([...argv], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe", env })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const timer = setTimeout(() => child.kill(), 15_000)
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    while (true) {
      const index = buffer.indexOf("\n")
      if (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const frame: unknown = JSON.parse(line)
        expect(frame).toMatchObject({ id })
        return frame
      }
      const next = await reader.read()
      if (next.done) throw new Error(`worker exited before ${method}: ${await stderr}`)
      buffer += decoder.decode(next.value, { stream: true })
    }
  }
  try {
    expect(await request(1, "hello", { workspace })).toEqual({ id: 1, result: { protocol: 2 } })
    expect(await request(2, "tool.list")).toMatchObject({
      id: 2,
      result: { tools: [{ name: "fixture", description: "Worker fixture" }] },
    })
    expect(await request(3, "tool.call", { name: "fixture", input: {} })).toEqual({
      id: 3,
      result: { result: `worker in ${workspace}` },
    })
    expect(await request(4, "tool.call", { name: "missing", input: {} })).toMatchObject({
      id: 4,
      error: { message: "unknown worker tool: missing" },
    })
    expect(await request(5, "shutdown")).toEqual({ id: 5, result: {} })
    expect(await child.exited).toBe(0)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
    reader.releaseLock()
    await stderr
  }
}

it.live(
  "worker manifests are private to their scope and execute through the product entry point",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const files = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* WorkerConfig.prepare()
          const second = yield* WorkerConfig.prepare()
          expect(first).not.toBe(second)
          const manifest = Schema.decodeUnknownSync(Manifest)(yield* Effect.promise(() => Bun.file(first).json()))
          expect(manifest.argv.at(-1)).toBe("__worker-host")
          yield* Effect.promise(() => verifyWorker(manifest.argv, tmp.path))
          expect(yield* Effect.promise(() => Bun.file(second).exists())).toBe(true)
          return [first, second]
        }),
      )
      expect(yield* Effect.promise(() => Promise.all(files.map((file) => Bun.file(file).exists())))).toEqual([
        false,
        false,
      ])
    }),
  25_000,
)

const packaged = process.env.MIAO_WORKER_HOST_BIN

test.skipIf(!packaged)(
  "compiled worker executes without a source entry or an external Bun command",
  async () => {
    await using tmp = await tmpdir()
    const executable = path.join(tmp.path, process.platform === "win32" ? "released-miao.exe" : "released-miao")
    await copyFile(packaged!, executable)
    await chmod(executable, 0o755)
    await verifyWorker([executable, "__worker-host"], tmp.path, {
      ...process.env,
      PATH: path.join(tmp.path, "no-external-runtime"),
    })
  },
  25_000,
)
