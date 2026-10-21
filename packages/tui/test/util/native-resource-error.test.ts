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
  ]) expect(isNativeResourceError(new Error(message))).toBe(true)
})

test("ordinary failures retain the interactive crash screen", () => {
  expect(isNativeResourceError(new Error("request failed"))).toBe(false)
  expect(isNativeResourceError(new Error("Failed to create session"))).toBe(false)
  expect(isNativeResourceError(new Error("undefined is not an object"))).toBe(false)
  expect(isNativeResourceError(undefined)).toBe(false)
})
