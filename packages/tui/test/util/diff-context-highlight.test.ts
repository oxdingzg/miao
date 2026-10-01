import { addDefaultParsers, getTreeSitterClient } from "@opentui/core"
import { expect, test } from "bun:test"
import { createTwoFilesPatch, parsePatch } from "diff"
import parsers from "../../src/parsers-config"
import { createDiffContextHighlighter } from "../../src/util/diff-context-highlight"

addDefaultParsers(parsers.parsers)

const before = [
  "def summarize(samples):",
  '    """Return the median width.',
  "",
  "    后脸端面只作旁证，不再覆盖。",
  '    """',
  "    import statistics",
  "    ss = [float(x) for x in (samples or []) if x]",
  "    if not ss:",
  "        return None",
  "    return statistics.median(ss)",
  "",
].join("\n")
const after = before.replace("    if not ss:", "    sample_count = len(ss)\n    if not sample_count:")
const patch = createTwoFilesPatch("a.py", "a.py", before, after, undefined, undefined, { context: 4 })

// The unified snippet the renderer builds: every hunk line without its marker.
const unified = parsePatch(patch)[0]
  .hunks.flatMap((hunk) => hunk.lines.map((line) => line.slice(1)))
  .join("\n")

function groupsOn(content: string, highlights: [number, number, string, ...unknown[]][], text: string) {
  const start = content.indexOf(text)
  return highlights.filter((h) => h[0] >= start && h[1] <= start + text.length).map((h) => h[2])
}

test("a hunk that starts inside a docstring keeps code highlighting with file context", async () => {
  await getTreeSitterClient().initialize()
  expect(unified.startsWith("    后脸端面只作旁证")).toBe(true)
  const isolated = (await getTreeSitterClient().highlightOnce(unified, "python")).highlights ?? []
  expect(groupsOn(unified, isolated, "if not sample_count:")).not.toContain("keyword")

  const client = createDiffContextHighlighter({ patch, current: after })
  expect(client).toBeDefined()
  const result = (await client!.highlightOnce(unified, "python")).highlights ?? []
  expect(groupsOn(unified, result, "if not sample_count:")).toContain("keyword")
  expect(groupsOn(unified, result, "    import statistics")).toContain("keyword")
  expect(groupsOn(unified, result, "    if not ss:")).toContain("keyword")
  expect(groupsOn(unified, result, "    后脸端面只作旁证，不再覆盖。")).toContain("string")
}, 60000)

test("split columns map removed lines to the old file and added lines to the new file", async () => {
  const client = createDiffContextHighlighter({ patch, current: after })!
  // Left column: context and removed lines, padded where the new side is longer.
  const left = [
    "    后脸端面只作旁证，不再覆盖。",
    '    """',
    "    import statistics",
    "    ss = [float(x) for x in (samples or []) if x]",
    "    if not ss:",
    "",
    "        return None",
    "    return statistics.median(ss)",
  ].join("\n")
  const result = (await client.highlightOnce(left, "python")).highlights ?? []
  expect(groupsOn(left, result, "    if not ss:")).toContain("keyword")
  expect(groupsOn(left, result, "    后脸端面只作旁证，不再覆盖。")).toContain("string")
}, 60000)

test("a file that changed after the patch keeps the default highlighter", () => {
  expect(
    createDiffContextHighlighter({ patch, current: after.replace("sample_count = len(ss)", "n = len(ss)") }),
  ).toBeUndefined()
  expect(createDiffContextHighlighter({ patch: "", current: after })).toBeUndefined()
})

test("content that is not one of the diff layouts falls back to plain highlighting", async () => {
  const client = createDiffContextHighlighter({ patch, current: after })!
  const result = (await client.highlightOnce("if x:\n    pass", "python")).highlights ?? []
  expect(result.map((h) => h[2])).toContain("keyword")
}, 60000)
