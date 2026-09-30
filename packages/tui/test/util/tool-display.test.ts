import { describe, expect, test } from "bun:test"
import { fileToolSummary, toolDisplayMetadata, webSearchProviderLabel } from "../../src/util/tool-display"

describe("fileToolSummary", () => {
  test("summarizes actual read pages without counting the trailing newline", () => {
    expect(fileToolSummary("read", { content: "one\ntwo\n", encoding: "utf8" })).toBe("Read 2 lines")
    expect(fileToolSummary("read", { content: "", encoding: "utf8" })).toBe("Read 0 lines")
    expect(fileToolSummary("read", { content: "one\n", truncated: true })).toBe("Read 1 line (truncated)")
    expect(fileToolSummary("read", { entries: [{ path: "src/" }], truncated: true })).toBe("Read 1 entry (truncated)")
    expect(fileToolSummary("read", { encoding: "base64", mime: "image/png", content: "AAAA" })).toBe("Read image")
    expect(fileToolSummary("read", {})).toBeUndefined()
  })

  test("uses committed FileDiff counts rather than replacement input text", () => {
    expect(fileToolSummary("edit", { files: [{ additions: 9, deletions: 7 }] })).toBe("Added 9 lines, removed 7 lines")
    expect(fileToolSummary("edit", { files: [{ additions: 1, deletions: 0 }] })).toBe("Added 1 line")
    expect(fileToolSummary("edit", { files: [{ additions: 0, deletions: 1 }] })).toBe("Removed 1 line")
    expect(fileToolSummary("edit", { files: [null, {}, { additions: NaN, deletions: 0 }] })).toBeUndefined()
    // A write commits the same FileDiff shape, so it renders the same summary.
    expect(fileToolSummary("write", { files: [{ additions: 3, deletions: 0 }] })).toBe("Added 3 lines")
    expect(fileToolSummary("write", { files: [{ additions: 2, deletions: 5 }] })).toBe("Added 2 lines, removed 5 lines")
  })
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an unexpected string", "other"],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns structured metadata for non-pending states", () => {
    const structured = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "completed", structured })).toBe(structured)
    expect(toolDisplayMetadata({ status: "error", structured })).toBe(structured)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "pending", structured: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", structured: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
