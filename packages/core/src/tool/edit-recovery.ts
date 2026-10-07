export * as EditRecovery from "./edit-recovery"

/**
 * One stale-edit recovery attempt. Runs only after the exact/fuzzy matcher
 * failed, so every outcome except `recovered` leaves the previous failure
 * verbatim. Location is proven by exact, unique context anchors — never
 * guessed — and the replaced region is bounded so a heavily drifted file is
 * refused instead of clobbered. `oldString` and `newString` must already be
 * normalized to the current text's line endings (the edit tool's `plan` does
 * this); the snapshot is the text the model last saw for the same file.
 */
export type Outcome =
  | { _tag: "recovered"; replaced: string; note: string }
  | { _tag: "refused"; reason: "ambiguous" | "unanchored" | "disproportionate" }
  | { _tag: "inapplicable" }

const MAX_CONTEXT_LINES = 3
const MAX_REGION_SLACK = 8

export function recover(input: { snapshot: string; current: string; oldString: string; newString: string }): Outcome {
  const { snapshot, current, oldString, newString } = input
  if (oldString === "" || current.includes(oldString)) return { _tag: "inapplicable" }
  const occurrences = countOccurrences(snapshot, oldString)
  if (occurrences === 0) return { _tag: "inapplicable" }
  if (occurrences > 1) return { _tag: "refused", reason: "ambiguous" }

  const snapshotLines = snapshot.split("\n")
  const currentLines = current.split("\n")
  const first = snapshot.indexOf(oldString)
  const blockStart = snapshot.slice(0, first).split("\n").length - 1
  const blockEnd = blockStart + oldString.split("\n").length - 1

  const above = anchor(snapshotLines, currentLines, blockStart - 1, -1)
  const below = anchor(snapshotLines, currentLines, blockEnd + 1, +1)
  if (above === undefined && below === undefined) return { _tag: "refused", reason: "unanchored" }

  const from = above === undefined ? 0 : above + 1
  const to = below === undefined ? currentLines.length : below
  const blockLines = blockEnd - blockStart + 1
  if (to - from > blockLines + MAX_REGION_SLACK) return { _tag: "refused", reason: "disproportionate" }

  const replaced = [...currentLines.slice(0, from), ...newString.split("\n"), ...currentLines.slice(to)].join("\n")
  if (replaced === current) return { _tag: "inapplicable" }
  const where = above === undefined ? "above the end of the file" : below === undefined ? "below the start of the file" : "between unchanged context lines"
  return {
    _tag: "recovered",
    replaced,
    note: `The file had drifted since the last read, so oldString was relocated ${where} and the edit was rebased onto the current content. The diff shows everything the rebase applied, including drift it replaced.`,
  }
}

function countOccurrences(text: string, needle: string) {
  let count = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++
  return count
}

/** Nearest non-empty snapshot line within reach that occurs exactly once in the current text. */
function anchor(snapshotLines: string[], currentLines: string[], start: number, step: -1 | 1): number | undefined {
  const current = currentLines.join("\n")
  for (let line = start; line >= 0 && line < snapshotLines.length && Math.abs(start - line) < MAX_CONTEXT_LINES; line += step) {
    const text = snapshotLines[line]
    if (text.trim() === "") continue
    if (countOccurrences(current, text) === 1) return currentLines.indexOf(text)
  }
  return undefined
}
