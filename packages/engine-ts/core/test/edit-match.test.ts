import { describe, expect, test } from "bun:test"
import { EditFuzzy } from "@miao/core/tool/edit-fuzzy"
import { EditMatch } from "@miao/core/tool/edit-match"

const matched = (result: EditMatch.Result) => {
  if (result._tag !== "match") throw new Error(`expected a match, received ${result._tag}`)
  return result
}

describe("EditMatch.matchTs", () => {
  test("replaces an exact unique occurrence", () => {
    expect(matched(EditMatch.matchTs("old content here", "old content", false))).toEqual({
      _tag: "match",
      find: "old content",
      count: 1,
    })
  })

  test("reports an exact match that another occurrence makes ambiguous", () => {
    expect(EditMatch.matchTs("same same", "same", false)).toEqual({ _tag: "ambiguous" })
  })

  test("reports self-overlapping patterns as ambiguous", () => {
    expect(EditMatch.matchTs("aaa", "aa", false)).toEqual({ _tag: "ambiguous" })
    expect(EditMatch.matchTs("aaaa", "aa", false)).toEqual({ _tag: "ambiguous" })
  })

  test("counts every non-overlapping occurrence with replaceAll", () => {
    expect(EditMatch.matchTs("same same same", "same", true)).toEqual({
      _tag: "match",
      find: "same",
      count: 3,
    })
  })

  test("recovers line-trimmed indentation differences", () => {
    const content = "function configure() {\n    const enabled = true\n}\n"
    expect(matched(EditMatch.matchTs(content, "function configure() {\n  const enabled = true\n}", false))).toEqual({
      _tag: "match",
      find: "function configure() {\n    const enabled = true\n}",
      count: 1,
    })
  })

  test("recovers internal whitespace differences", () => {
    const content = "const value = compute(alpha,    beta)\nnext line\n"
    expect(matched(EditMatch.matchTs(content, "const value = compute(alpha, beta)", false))).toEqual({
      _tag: "match",
      find: "const value = compute(alpha,    beta)",
      count: 1,
    })
  })

  test("recovers a fuzzy block anchor with a close middle", () => {
    const content = ["start", "  alpha beta gamma", "end"].join("\n")
    expect(matched(EditMatch.matchTs(content, ["start", "  alpha beta delta", "end"].join("\n"), false))).toEqual({
      _tag: "match",
      find: content,
      count: 1,
    })
  })

  test("rejects a block anchor whose middle is unrelated", () => {
    const content = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
    expect(EditMatch.matchTs(content, ["function configure() {", "  const enabled = true", "}"].join("\n"), false)).toEqual(
      { _tag: "none" },
    )
  })

  test("recovers a context-aware block when half the middle lines agree", () => {
    const content = ["A", "x", "ZZZZZZZZZZZZZZZZ", "B"].join("\n")
    expect(matched(EditMatch.matchTs(content, ["A", "x", "y", "B"].join("\n"), false))).toEqual({
      _tag: "match",
      find: content,
      count: 1,
    })
  })

  test("recovers a search the model escaped with a literal backslash-n", () => {
    const content = 'const message = "line\nbreak"\n'
    expect(matched(EditMatch.matchTs(content, 'const message = "line\\nbreak"', false))).toEqual({
      _tag: "match",
      find: 'const message = "line\nbreak"',
      count: 1,
    })
  })

  test("trims a line boundary that differs only by surrounding whitespace", () => {
    const content = "  padded block  \ntail\n"
    expect(matched(EditMatch.matchTs(content, "\tpadded block", false))).toEqual({
      _tag: "match",
      find: "  padded block  ",
      count: 1,
    })
  })

  test("rejects a fuzzy match that starts mid-line instead of swallowing the prefix", () => {
    expect(EditMatch.matchTs("  xfoo   y\nbar\n", "foo y", false)).toEqual({ _tag: "none" })
  })

  test("refuses a disproportionate fuzzy span", () => {
    const content = `a${" ".repeat(600)}b\nc${" ".repeat(600)}d\n`
    expect(EditMatch.matchTs(content, "a b\nc d", false)).toEqual({ _tag: "disproportionate" })
  })

  test("returns none for absent text", () => {
    expect(EditMatch.matchTs("actual content", "not in file", false)).toEqual({ _tag: "none" })
  })

  test("keeps exact CRLF matching byte-exact", () => {
    const content = "line1\r\nold\r\nline3"
    expect(matched(EditMatch.matchTs(content, "old", false))).toEqual({ _tag: "match", find: "old", count: 1 })
  })

  test("recovers indentation in CRLF content without dropping the carriage return", () => {
    const content = "a\r\n    old\r\nb\r\n"
    expect(matched(EditMatch.matchTs(content, "\told", false))).toEqual({
      _tag: "match",
      find: "    old\r",
      count: 1,
    })
  })

  test("matches Unicode content by code point", () => {
    const content = "  héllo wörld  \nrest\n"
    expect(matched(EditMatch.matchTs(content, "\théllo wörld", false))).toEqual({
      _tag: "match",
      find: "  héllo wörld  ",
      count: 1,
    })
  })

  test("keeps the backend result equal to the reference when native is absent", () => {
    const cases: Array<[string, string, boolean]> = [
      ["old content here", "old content", false],
      ["same same", "same", false],
      ["function f() {\n  a\n  b\n}\n", "function f() {\n    a\n    b\n}", false],
      ["x = 1\nx = 1\n", "x = 1", false],
      ["  xfooy\nbar\n", "foo", false],
      ["actual content", "missing", false],
    ]
    for (const [content, oldString, replaceAll] of cases) {
      expect(EditMatch.match(content, oldString, replaceAll)).toEqual(
        EditMatch.matchTs(content, oldString, replaceAll),
      )
    }
  })
})

describe("EditFuzzy candidate strategies", () => {
  test("reject an all-whitespace search", () => {
    expect(EditFuzzy.fuzzyCandidates("a\nb\n", "   ")).toEqual([])
  })

  test("report a disproportionate helper result for long same-line-count spans", () => {
    expect(EditFuzzy.isDisproportionateMatch(`${"x".repeat(2000)}\ny`, "a\nb")).toBe(true)
    expect(EditFuzzy.isDisproportionateMatch("a\nb", "a\nb")).toBe(false)
  })

  test("count non-overlapping occurrences like replaceAll", () => {
    expect(EditFuzzy.countOccurrences("aaaa", "aa")).toBe(2)
    expect(EditFuzzy.countOccurrences("abc", "")).toBe(4)
  })
})
