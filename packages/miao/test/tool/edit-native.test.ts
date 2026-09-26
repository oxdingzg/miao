import { describe, expect, test } from "bun:test"
import { createRequire } from "module"
import path from "path"
import { createTwoFilesPatch, diffLines } from "diff"
import { replace } from "../../src/tool/edit"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  applyEdit(
    content: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): { content: string; additions: number; deletions: number }
  diffStats(before: string, after: string): { additions: number; deletions: number }
  unifiedPatch(before: string, after: string, filePath: string): string
}

const native: Native | undefined = (() => {
  try {
    return require(nativePath) as Native
  } catch {
    return undefined
  }
})()

type Case = { name: string; content: string; oldString: string; newString: string; replaceAll?: boolean }

function outcome(run: () => string) {
  try {
    return { ok: true as const, value: run() }
  } catch (error) {
    return { ok: false as const, message: (error as Error).message }
  }
}

const withNative = native ? describe : describe.skip

withNative("native edit parity", () => {
  const cases: Case[] = [
    { name: "exact", content: "old content here", oldString: "old content", newString: "new content" },
    { name: "replaceAll", content: "foo bar foo baz foo", oldString: "foo", newString: "qux", replaceAll: true },
    { name: "multiline", content: "line1\nline2\nline3", oldString: "line2", newString: "new line 2\nextra line" },
    { name: "crlf", content: "line1\r\nold\r\nline3", oldString: "old", newString: "new" },
    {
      name: "bom",
      content: "\uFEFFusing System;\nclass Test {}\n",
      oldString: "using System;",
      newString: "using Up;",
    },
    {
      name: "line-trimmed indentation",
      content: "function configure() {\n    const enabled = true\n}\n",
      oldString: "function configure() {\n  const enabled = true\n}",
      newString: "let result = 1",
    },
    {
      name: "whitespace-normalized",
      content: "const value = compute(  alpha,   beta )\nnext line\n",
      oldString: "const value = compute(alpha, beta)",
      newString: "const value = 0",
    },
    {
      name: "trimmed boundary",
      content: "  padded block  \ntail\n",
      oldString: "padded block",
      newString: "flush",
    },
    {
      name: "escape normalized",
      content: 'const message = "line\\nbreak"\n',
      oldString: 'const message = "line\nbreak"',
      newString: "const message = ok",
    },
    {
      name: "block anchor fuzzy single candidate",
      content: ["start", "  alpha beta gamma", "end"].join("\n"),
      oldString: ["start", "  alpha beta delta", "end"].join("\n"),
      newString: "matched",
    },
    {
      name: "block anchor rejection unrelated middle",
      content: ["function configure() {", "  removeAllUserData()", "}"].join("\n"),
      oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
      newString: "x",
    },
    { name: "not found", content: "actual content", oldString: "not in file", newString: "replacement" },
    { name: "identical", content: "content", oldString: "same", newString: "same" },
    { name: "empty old", content: "content", oldString: "", newString: "x" },
    { name: "multiple without replaceAll", content: "a foo b foo c", oldString: "foo", newString: "bar" },
  ]

  for (const testCase of cases) {
    test(`matches TS replace: ${testCase.name}`, () => {
      const expected = outcome(() => replace(testCase.content, testCase.oldString, testCase.newString, testCase.replaceAll ?? false))
      const actual = outcome(() => native!.applyEdit(testCase.content, testCase.oldString, testCase.newString, testCase.replaceAll ?? false).content)
      expect(actual).toEqual(expected)
    })
  }

  test("matches TS replace across generated corpus", () => {
    const random = mulberry32(0x5eed)
    const tokens = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    let mismatches = 0

    for (let iteration = 0; iteration < 400; iteration++) {
      const lineCount = 3 + Math.floor(random() * 20)
      const lines = Array.from({ length: lineCount }, (_, i) => {
        const indent = " ".repeat(Math.floor(random() * 4))
        return `${indent}${tokens[Math.floor(random() * tokens.length)]} ${i} ${tokens[Math.floor(random() * tokens.length)]}`
      })
      const content = lines.join("\n")
      const start = Math.floor(random() * (lineCount - 2))
      const length = 1 + Math.floor(random() * Math.min(4, lineCount - start))
      const block = lines.slice(start, start + length)

      const mode = Math.floor(random() * 5)
      const oldString =
        mode === 0
          ? block.join("\n")
          : mode === 1
            ? block.map((line) => line.trim()).join("\n")
            : mode === 2
              ? block.map((line) => line.replace(/\s+/g, " ").trim()).join("\n")
              : mode === 3
                ? block.map((line, i) => (i === 0 ? "  " + line.trim() : line)).join("\n")
                : block.map((line, i) => (i === 1 ? line + " extra" : line)).join("\n")

      const newString = `REPLACED_${iteration}`
      const replaceAll = random() < 0.25

      const expected = outcome(() => replace(content, oldString, newString, replaceAll))
      const actual = outcome(() => native!.applyEdit(content, oldString, newString, replaceAll).content)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches++
        if (mismatches <= 5) console.error({ iteration, mode, oldString, newString, expected, actual })
      }
    }

    expect(mismatches).toBe(0)
  })

  test("diff stats match jsdiff diffLines", () => {
    const pairs: Array<[string, string]> = [
      ["line1\nline2\nline3", "line1\nnew a\nnew b\nline3"],
      ["a\nb\nc\nd", "a\nc\nd"],
      ["", "brand new\nfile"],
      ["remove everything\n", ""],
      [Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), Array.from({ length: 200 }, (_, i) => `line ${i * 2}`).join("\n")],
    ]
    for (const [before, after] of pairs) {
      const stats = diffLines(before, after).reduce(
        (acc, change) => ({
          additions: acc.additions + (change.added ? (change.count ?? 0) : 0),
          deletions: acc.deletions + (change.removed ? (change.count ?? 0) : 0),
        }),
        { additions: 0, deletions: 0 },
      )
      expect(native!.diffStats(before, after)).toEqual(stats)
    }
  })

  test("unified patch matches jsdiff createTwoFilesPatch", () => {
    const pairs: Array<[string, string]> = [
      ["l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10", "l1\nl2\nl3\nl4\nCHANGED\nl6\nl7\nl8\nl9\nl10"],
      ["a\nb\nc", "a\nB\nc"],
      [
        Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
        Array.from({ length: 30 }, (_, i) => (i === 15 ? "CHANGED" : `line ${i}`)).join("\n"),
      ],
    ]
    for (const [before, after] of pairs) {
      expect(native!.unifiedPatch(before, after, "f.txt")).toBe(createTwoFilesPatch("f.txt", "f.txt", before, after))
    }
  })
})

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
