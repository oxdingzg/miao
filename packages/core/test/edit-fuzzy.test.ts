import { describe, expect, test } from "bun:test"
import { EditFuzzy } from "@miao/core/tool/edit-fuzzy"

describe("EditFuzzy.matchFuzzy", () => {
  test("matches despite indentation and trailing whitespace differences", () => {
    const text = "function f() {\n    const x = 1   \n    return x\n}\n"
    expect(EditFuzzy.matchFuzzy(text, "  const x = 1\n  return x")).toBe("    const x = 1   \n    return x")
  })

  test("returns undefined when absent or ambiguous", () => {
    expect(EditFuzzy.matchFuzzy("a\nb\n", "zzz")).toBeUndefined()
    expect(EditFuzzy.matchFuzzy("x = 1\nx = 1\n", "x = 1")).toBeUndefined()
  })
})
