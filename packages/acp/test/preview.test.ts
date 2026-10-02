import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { applyIndented, editChanges } from "../src/preview"

const source = [
  "class A {",
  "  method() {",
  "    a()",
  "    b()",
  "    c()",
  "    d()",
  "    e()",
  "    f()",
  "    g()",
  "  }",
  "}",
  "",
].join("\n")
const expected = source.replace("    d()", "    D()")

// The edit tool's prompt diff with the shared four-space indentation removed (core `trimDiff`).
const trimmed = [
  "Index: /work/a.ts",
  "===================================================================",
  "--- /work/a.ts",
  "+++ /work/a.ts",
  "@@ -3,7 +3,7 @@",
  " a()",
  " b()",
  " c()",
  "-d()",
  "+D()",
  " e()",
  " f()",
  " g()",
  "",
].join("\n")

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

describe("applyIndented", () => {
  test("applies an untrimmed diff directly", () => {
    expect(applyIndented(source, createTwoFilesPatch("a.ts", "a.ts", source, expected))).toBe(expected)
  })

  test("restores the indentation a prompt diff removed", () => {
    expect(applyIndented(source, trimmed)).toBe(expected)
  })

  test("gives up on a diff that does not match the file", () => {
    expect(applyIndented("unrelated\n", trimmed)).toBeUndefined()
  })
})

describe("editChanges", () => {
  test("reconstructs edit and apply_patch requests from the files on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acp-preview-"))
    dirs.push(dir)
    await Bun.write(path.join(dir, "a.ts"), source)
    await Bun.write(path.join(dir, "gone.ts"), "bye\n")

    expect(await editChanges({ filepath: path.join(dir, "a.ts"), diff: trimmed }, dir)).toEqual([
      { path: path.join(dir, "a.ts"), oldText: source, newText: expected },
    ])
    expect(
      await editChanges(
        { filepath: path.join(dir, "new.ts"), diff: createTwoFilesPatch("new.ts", "new.ts", "", "hi\n") },
        dir,
      ),
    ).toEqual([{ path: path.join(dir, "new.ts"), oldText: "", newText: "hi\n" }])
    expect(
      await editChanges(
        {
          filepath: "a.ts, gone.ts",
          files: [
            { file: "a.ts", status: "modified", patch: createTwoFilesPatch("a.ts", "a.ts", source, expected) },
            { file: "gone.ts", status: "deleted", patch: createTwoFilesPatch("gone.ts", "gone.ts", "bye\n", "") },
          ],
        },
        dir,
      ),
    ).toEqual([
      { path: path.join(dir, "a.ts"), oldText: source, newText: expected },
      { path: path.join(dir, "gone.ts"), oldText: "bye\n", newText: "" },
    ])
  })
})
