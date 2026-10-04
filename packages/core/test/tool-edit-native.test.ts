import { describe, expect, test } from "bun:test"
import { native } from "@miao/native"
import { EditMatch } from "@miao/core/tool/edit-match"

/**
 * Parity between the shared contract's TypeScript reference and the Rust
 * `matchEdit` primitive. The addon is absent in a plain checkout, so the suite
 * skips; CI builds it and sets `MIAO_NATIVE_REQUIRED=1` to fail instead.
 */
const activeNative = typeof native?.matchEdit === "function" ? native : undefined

if (process.env.MIAO_NATIVE_REQUIRED === "1" && activeNative === undefined) {
  throw new Error("MIAO_NATIVE_REQUIRED=1 but the @miao/native addon does not expose matchEdit")
}

type Case = { content: string; oldString: string; replaceAll?: boolean }

const canonicalNative = (content: string, oldString: string, replaceAll: boolean): EditMatch.Result => {
  const result = activeNative!.matchEdit(content, oldString, replaceAll)
  if (result.kind === "match") return { _tag: "match", find: result.find ?? "", count: result.count ?? 0 }
  if (result.kind === "ambiguous") return { _tag: "ambiguous" }
  if (result.kind === "disproportionate") return { _tag: "disproportionate" }
  return { _tag: "none" }
}

const cases: Case[] = [
  { content: "old content here", oldString: "old content" },
  { content: "foo bar foo baz foo", oldString: "foo", replaceAll: true },
  { content: "same same", oldString: "same" },
  { content: "aaa", oldString: "aa" },
  { content: "aaaa", oldString: "aa" },
  { content: "line1\nline2\nline3", oldString: "line2" },
  { content: "line1\r\nold\r\nline3", oldString: "old" },
  { content: "\uFEFFusing System;\nclass Test {}\n", oldString: "using System;" },
  { content: "function configure() {\n    const enabled = true\n}\n", oldString: "function configure() {\n  const enabled = true\n}" },
  { content: "const value = compute(alpha,    beta)\nnext line\n", oldString: "const value = compute(alpha, beta)" },
  { content: "  padded block  \ntail\n", oldString: "\tpadded block" },
  { content: 'const message = "line\nbreak"\n', oldString: 'const message = "line\\nbreak"' },
  { content: ["start", "  alpha beta gamma", "end"].join("\n"), oldString: ["start", "  alpha beta delta", "end"].join("\n") },
  { content: ["A", "x", "ZZZZZZZZZZZZZZZZ", "B"].join("\n"), oldString: ["A", "x", "y", "B"].join("\n") },
  { content: ["function configure() {", "  removeAllUserData()", "}"].join("\n"), oldString: ["function configure() {", "  const enabled = true", "}"].join("\n") },
  { content: "  xfoo   y\nbar\n", oldString: "foo y" },
  { content: `a${" ".repeat(600)}b\nc${" ".repeat(600)}d\n`, oldString: "a b\nc d" },
  { content: "  héllo wörld  \nrest\n", oldString: "\théllo wörld" },
  { content: "actual content", oldString: "not in file" },
  { content: "x = 1\nx = 1\n", oldString: "x = 1" },
]

const withNative = activeNative ? describe : describe.skip

withNative("native edit match parity", () => {
  test("matchTs and the addon agree on the fixture set", () => {
    for (const testCase of cases) {
      const replaceAll = testCase.replaceAll ?? false
      const expected = canonicalNative(testCase.content, testCase.oldString, replaceAll)
      expect(EditMatch.matchTs(testCase.content, testCase.oldString, replaceAll)).toEqual(expected)
    }
  })

  test("the wired backend selects the native primitive and stays equal", () => {
    expect(EditMatch.nativeActive()).toBe(true)
    for (const testCase of cases) {
      const replaceAll = testCase.replaceAll ?? false
      expect(EditMatch.match(testCase.content, testCase.oldString, replaceAll)).toEqual(
        EditMatch.matchTs(testCase.content, testCase.oldString, replaceAll),
      )
    }
  })

  test("matchTs and the addon agree across a generated corpus", () => {
    const random = mulberry32(0x5eed)
    const tokens = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    let mismatches = 0
    for (let iteration = 0; iteration < 600; iteration++) {
      const lineCount = 3 + Math.floor(random() * 20)
      const lines = Array.from({ length: lineCount }, (_, index) => {
        const indent = " ".repeat(Math.floor(random() * 4))
        return `${indent}${tokens[Math.floor(random() * tokens.length)]} ${index} ${tokens[Math.floor(random() * tokens.length)]}`
      })
      const content = lines.join("\n")
      const start = Math.floor(random() * (lineCount - 2))
      const length = 1 + Math.floor(random() * Math.min(4, lineCount - start))
      const block = lines.slice(start, start + length)
      const mode = Math.floor(random() * 6)
      const oldString =
        mode === 0
          ? block.join("\n")
          : mode === 1
            ? block.map((line) => line.trim()).join("\n")
            : mode === 2
              ? block.map((line) => line.replace(/\s+/g, " ").trim()).join("\n")
              : mode === 3
                ? block.map((line, index) => (index === 0 ? `  ${line.trim()}` : line)).join("\n")
                : mode === 4
                  ? block.map((line, index) => (index === 1 ? `${line} extra` : line)).join("\n")
                  : block.join("\r\n")
      const replaceAll = random() < 0.25
      const expected = EditMatch.matchTs(content, oldString, replaceAll)
      const actual = canonicalNative(content, oldString, replaceAll)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches++
        if (mismatches <= 5) console.error({ iteration, mode, oldString, expected, actual })
      }
    }
    expect(mismatches).toBe(0)
  })
})

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
