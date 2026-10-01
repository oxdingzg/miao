import { expect, test } from "bun:test"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

test("preview preserves short output and caps long lines without splitting Unicode", () => {
  expect(collapseToolOutput("ok\nfinished", 3, 40)).toEqual({ output: "ok\nfinished", overflow: false })
  expect(collapseToolOutput("a\nb\nc\nd", 3, 40)).toEqual({ output: "a\nb\nc\n…", overflow: true })
  expect(collapseToolOutput("😀😀😀😀😀", 3, 4)).toEqual({ output: "😀😀😀…", overflow: true })
  expect(collapseToolOutput("abcd", 3, 4)).toEqual({ output: "abcd", overflow: false })
})

test("multi-megabyte output is previewed without materializing its entire contents", () => {
  const output = "one\ntwo\nthree\n" + "x".repeat(8 * 1024 * 1024)
  const start = performance.now()
  for (let i = 0; i < 100; i++) {
    expect(collapseToolOutput(output, 3, 300)).toEqual({ output: "one\ntwo\nthree\n…", overflow: true })
  }
  // A generous budget catches regressions that split/copy the 8 MB tail on
  // every preview, while allowing slower CI runners plenty of headroom.
  expect(performance.now() - start).toBeLessThan(1000)
})
