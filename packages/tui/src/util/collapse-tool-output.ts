// The changed hunk is what an edit row is for, so a diff too long to show whole
// still previews its first lines. Hiding it behind a click removes the only
// useful part of the row.
//
// The preview has to stay a patch a unified-diff parser accepts: its renderer
// reads the hunk headers, and `diff`'s parser throws when a header promises more
// lines than the slice carries. Cutting mid-hunk and rewriting that header to
// the lines actually kept keeps the preview parseable.
export function diffPreview(diff: string, maxLines: number) {
  const lines = diff.split("\n")
  if (lines.length <= maxLines) return undefined
  const patch = closeHunk(lines.slice(0, maxLines))
  if (!patch) return undefined
  return { patch: patch.join("\n"), hidden: lines.length - maxLines }
}

function closeHunk(lines: string[]) {
  const index = lines.findLastIndex((line) => line.startsWith("@@"))
  if (index < 0) return undefined
  const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[index])
  if (!header) return undefined
  const counts = { old: 0, new: 0 }
  for (const line of lines.slice(index + 1)) {
    // `\ No newline at end of file` annotates the line above it.
    if (line.startsWith("\\")) continue
    const tag = line === "" ? " " : line[0]
    if (tag === " ") {
      counts.old++
      counts.new++
    } else if (tag === "-") {
      counts.old++
    } else if (tag === "+") {
      counts.new++
    } else {
      return undefined
    }
  }
  // A header whose body was cut away entirely leaves nothing to render, and the
  // caller falls back to its "click to view diff" hint.
  if (counts.old === 0 && counts.new === 0) return undefined
  return [
    ...lines.slice(0, index),
    `@@ -${header[1]},${counts.old} +${header[2]},${counts.new} @@${header[3]}`,
    ...lines.slice(index + 1),
  ]
}

export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  // Only walk the preview. Splitting a multi-megabyte tool result and building
  // Array.from(output) just to display three lines creates avoidable heap churn.
  const preview: string[] = []
  let lines = 1
  for (const char of output) {
    if (char === "\n" && lines >= maxLines) {
      return { output: preview.join("") + "\n…", overflow: true }
    }
    if (preview.length >= maxChars) {
      return { output: preview.slice(0, Math.max(0, maxChars - 1)).join("") + "…", overflow: true }
    }
    preview.push(char)
    if (char === "\n") lines++
  }
  return { output, overflow: false }
}
