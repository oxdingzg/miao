import { expect, test } from "bun:test"
import { stdinPreview } from "../../src/util/stdin-preview"

test("stdin preview names the script size and folds long scripts like tool output", () => {
  expect(stdinPreview("echo hi\n", 3, 200)).toEqual({
    heading: "stdin (1 line, 8 bytes)",
    output: "echo hi\n",
    overflow: false,
  })
  expect(stdinPreview("", 3, 200)).toEqual({ heading: "stdin (0 lines, 0 bytes)", output: "", overflow: false })
  expect(stdinPreview("a\nb\nc\nd\ne", 3, 200)).toEqual({
    heading: "stdin (5 lines, 9 bytes)",
    output: "a\nb\nc\n…",
    overflow: true,
  })
  expect(stdinPreview("中文", 3, 200).heading).toBe("stdin (1 line, 6 bytes)")
})
