import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { isNativeResourceError } from "../../src/util/native-resource-error"

test("native allocation errors must not try to allocate a rich crash screen", () => {
  for (const message of [
    "Failed to create TextBuffer",
    "Failed to create TextBufferView",
    "Failed to create SyntaxStyle",
    "Failed to create native renderable",
    "Failed to create optimized buffer: 80x24",
    "Failed to create EditBuffer",
    "Failed to create EditorView",
  ])
    expect(isNativeResourceError(new Error(message))).toBe(true)
})

test("ordinary failures retain the interactive crash screen", () => {
  expect(isNativeResourceError(new Error("request failed"))).toBe(false)
  expect(isNativeResourceError(new Error("Failed to create session"))).toBe(false)
  expect(isNativeResourceError(new Error("undefined is not an object"))).toBe(false)
  expect(isNativeResourceError(undefined)).toBe(false)
})

test("a genuinely exhausted native pool exits the renderer without allocating a crash screen", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      "@opentui/solid/preload",
      fileURLToPath(new URL("../fixture/native-allocation-failure.tsx", import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
  if (!result || typeof result !== "object" || !("failure" in result) || typeof result.failure !== "string") {
    throw new Error("Native failure probe did not return its diagnostic result")
  }
  expect(result).toMatchObject({ handled: 1, fallback: 0, destroyed: true })
  expect(isNativeResourceError(new Error(result.failure))).toBe(true)
}, 45000)
