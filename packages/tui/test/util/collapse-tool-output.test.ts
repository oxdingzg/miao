import { expect, test } from "bun:test"
import { parsePatch } from "diff"
import { collapseToolOutput, diffPreview } from "../../src/util/collapse-tool-output"

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

test("a diff longer than the budget previews its head and counts the rest", () => {
  expect(diffPreview("+one\n-two", 4)).toBeUndefined()
  const patch = `Index: a.txt\n${"=".repeat(67)}\n--- a.txt\n+++ a.txt\n@@ -1,5 +1,6 @@\n one\n-two\n+TWO\n+extra\n three\n four\n`
  const preview = diffPreview(patch, 9)!
  expect(preview.hidden).toBe(patch.split("\n").length - 9)
  expect(preview.patch).toContain("@@ -1,2 +1,3 @@")
  // The preview is what the diff renderer parses, so a header that promises
  // lines the slice does not carry would throw there and take the session down.
  expect(parsePatch(preview.patch)[0]!.hunks[0]).toMatchObject({ oldLines: 2, newLines: 3 })
})

test("a preview whose hunk body was cut away entirely renders nothing", () => {
  expect(diffPreview(`Index: a.txt\n${"=".repeat(67)}\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n`, 5)).toBeUndefined()
})
