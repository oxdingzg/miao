export * as EditFuzzy from "./edit-fuzzy"

const normalizeLine = (line: string) => line.trim()

/**
 * Finds the region of `text` that `search` most likely refers to when an exact
 * match fails, tolerating leading/trailing whitespace and indentation
 * differences per line. Returns the actual substring from `text` so the caller
 * can replace it exactly, or `undefined` when there is no confident match.
 */
export const matchFuzzy = (text: string, search: string): string | undefined => {
  const target = search.split("\n").map(normalizeLine).join("\n")
  if (target.trim().length === 0) return undefined

  const lines = text.split("\n")
  let normalized = ""
  const offsets: number[] = []
  let cursor = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const trimmed = normalizeLine(line)
    const leading = line.length - line.trimStart().length
    for (let column = 0; column < trimmed.length; column++) {
      normalized += trimmed[column]
      offsets.push(cursor + leading + column)
    }
    if (index < lines.length - 1) {
      normalized += "\n"
      offsets.push(cursor + line.length)
    }
    cursor += line.length + 1
  }

  const start = normalized.indexOf(target)
  if (start < 0) return undefined
  if (normalized.indexOf(target, start + 1) >= 0) return undefined
  const last = start + target.length - 1
  const mapped = offsets[start]
  const end = last < offsets.length ? offsets[last]! + 1 : text.length
  if (mapped === undefined) return undefined
  // Include the first matched line's leading indentation.
  let begin = mapped
  while (begin > 0 && text[begin - 1] !== "\n") begin--
  return text.slice(begin, end)
}
