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
