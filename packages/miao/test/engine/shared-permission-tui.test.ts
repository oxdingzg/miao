import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, realpath } from "node:fs/promises"
import { Schema } from "effect"
import { NativePermissionContext } from "@/engine/native-permission-context"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "the TUI shim selects paired Root ownership and preserves it without the preview flag",
  async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "workspace"))
    const workspace = await realpath(path.join(tmp.path, "workspace"))
    const first = await observe(tmp.path, workspace, true)
    expect(first.code).toBe(0)
    const before = Schema.decodeUnknownSync(NativePermissionContext.Observation)(first.result)
    expect(before.snapshot.project.migration?.imported).toBe(0)
    expect(before.snapshot.migration?.imported).toBe(0)
    const reopened = await observe(tmp.path, workspace, false)
    expect(reopened.code).toBe(0)
    const after = Schema.decodeUnknownSync(NativePermissionContext.Observation)(reopened.result)
    expect(after.snapshot.project.authority).toBe(before.snapshot.project.authority)
    expect(after.snapshot.directory).toBe(before.snapshot.directory)
  },
  60_000,
)

test.skipIf(!binary)(
  "a failed TUI permission preparation exits without a legacy engine fallback",
  async () => {
    await using tmp = await tmpdir()
    const observed = await observe(tmp.path, await realpath(tmp.path), true)
    expect(observed.code).toBe(1)
    expect(observed.result).toBeUndefined()
    expect(observed.stderr).toContain("outside the workspace")
  },
  30_000,
)

async function observe(tmp: string, workspace: string, enabled: boolean) {
  const child = Bun.spawn(
    [
      process.execPath,
      "src/index.ts",
      "__engine-shim",
      "serve",
      "--db",
      path.join(tmp, "source.db"),
      "--workspace",
      workspace,
      "--model",
      "fixture/fixture",
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_REAL_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:9",
        OPENAI_API_KEY: "fixture-only",
        MIAO_SHARED_PERMISSIONS: enabled ? "1" : "",
        MIAO_DB: path.join(tmp, "core.db"),
        MIAO_PURE: "1",
        MIAO_TEST_HOME: path.join(tmp, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp, "managed"),
        XDG_CONFIG_HOME: path.join(tmp, "config"),
        XDG_DATA_HOME: path.join(tmp, "data"),
        XDG_STATE_HOME: path.join(tmp, "state"),
        XDG_CACHE_HOME: path.join(tmp, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          formatter: false,
          lsp: false,
          providers: {
            fixture: {
              name: "Fixture",
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "http://127.0.0.1:9",
                settings: { apiKey: "fixture-only" },
              },
              models: { fixture: { name: "Fixture" } },
            },
          },
        }),
      },
    },
  )
  const stderr = new Response(child.stderr).text()
  const output = new Response(child.stdout).text()
  const deadline = setTimeout(() => child.kill(), 25_000)
  try {
    child.stdin.write(JSON.stringify({ id: 1, method: "shared_permission_snapshot" }) + "\n")
    child.stdin.write(JSON.stringify({ id: 2, method: "shutdown" }) + "\n")
    await child.stdin.flush()
    const code = await child.exited
    const frames = (await output)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
    return { code, result: frames.find((frame) => frame.id === 1)?.result, stderr: await stderr }
  } finally {
    clearTimeout(deadline)
    child.kill()
    await child.exited
  }
}
