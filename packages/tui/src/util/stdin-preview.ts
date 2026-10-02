import { collapseToolOutput } from "./collapse-tool-output"

/**
 * Folded preview of a bash call's stdin: a heading with its size, then the
 * first lines cut the same way tool output previews are. The script is part of
 * what runs, so approval prompts and the transcript both show it.
 */
export function stdinPreview(stdin: string, maxLines: number, maxChars: number) {
  const lines = countLines(stdin)
  const bytes = Buffer.byteLength(stdin, "utf8")
  return {
    heading: `stdin (${lines} ${lines === 1 ? "line" : "lines"}, ${bytes} ${bytes === 1 ? "byte" : "bytes"})`,
    ...collapseToolOutput(stdin, maxLines, maxChars),
  }
}

function countLines(text: string) {
  if (text === "") return 0
  let count = text.endsWith("\n") ? 0 : 1
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++
  return count
}
