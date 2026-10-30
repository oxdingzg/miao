import { describe, expect, test } from "bun:test"
import {
  isDuplicateEntry,
  MAX_HISTORY_ENTRIES,
  parsePromptHistory,
  previousHistoryMatch,
  type PromptInfo,
} from "../../src/prompt/history"

const entry = (input: string, parts: PromptInfo["parts"] = []): PromptInfo => ({ input, parts })

describe("prompt history", () => {
  test("recovers valid JSONL entries around corruption", () => {
    expect(parsePromptHistory(`${JSON.stringify(entry("one"))}\nnot-json\n${JSON.stringify(entry("two"))}\n`)).toEqual([
      entry("one"),
      entry("two"),
    ])
  })

  test("retains only the newest entries", () => {
    const input = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) =>
      JSON.stringify(entry(String(index))),
    ).join("\n")
    const result = parsePromptHistory(input)
    expect(result).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(result[0]?.input).toBe("5")
  })

  test("dedupes only identical consecutive entries", () => {
    expect(isDuplicateEntry(undefined, entry("hello"))).toBe(false)
    expect(isDuplicateEntry(entry("hello"), entry("hello"))).toBe(true)
    expect(isDuplicateEntry(entry("foo"), entry("bar"))).toBe(false)
    expect(isDuplicateEntry({ ...entry("ls"), mode: "normal" }, { ...entry("ls"), mode: "shell" })).toBe(false)
  })

  test("does not dedupe entries with different parts", () => {
    const a = entry("describe this", [
      { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
    ])
    const b = entry("describe this", [
      { type: "file", mime: "image/png", filename: "b.png", url: "data:image/png;base64,BBB" },
    ])
    expect(isDuplicateEntry(a, b)).toBe(false)
  })

  test("reverse search walks matching entries oldest-bound without a query", () => {
    const history = [entry("fix auth"), entry("ship release"), entry("fix docs")]
    // No query: nothing to match.
    expect(previousHistoryMatch(history, 0, "", "")).toBeUndefined()
    // First press from the typed prefix jumps to the newest match.
    expect(previousHistoryMatch(history, 0, "fix", "fix")?.entry.input).toBe("fix docs")
    // Each further press walks one matching entry older.
    expect(previousHistoryMatch(history, -1, "fix", "fix docs")?.entry.input).toBe("fix auth")
    // Past the oldest match there is nothing left.
    expect(previousHistoryMatch(history, -3, "fix", "fix auth")).toBeUndefined()
  })

  test("editing the input restarts the search for the new query", () => {
    const history = [entry("fix auth"), entry("ship release")]
    // The cursor parked on a match, but the user changed the typed text.
    expect(previousHistoryMatch(history, -1, "ship", "something else")?.entry.input).toBe("ship release")
  })

  test("non-matching queries leave the cursor alone", () => {
    const history = [entry("fix auth"), entry("ship release")]
    expect(previousHistoryMatch(history, 0, "zzz", "zzz")).toBeUndefined()
  })
})
