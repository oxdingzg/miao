export * as EditFuzzy from "./edit-fuzzy"

/**
 * Pure, model-agnostic fuzzy matching for the V2 edit tool.
 *
 * The strategies below are ported back from miao's own V1 edit tool (removed in
 * 55dc46784), which in turn adapted:
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts
 *
 * Every strategy only ever returns substrings that already exist in the content;
 * it never constructs replacement text. The caller owns the V2 safety policy:
 * a candidate must be line-anchored, must be unique (unless replacing all) and
 * must not be a disproportionate span. A mid-line candidate is rejected rather
 * than expanded to the line start, which would swallow unrelated characters.
 */

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

export type Result =
  | { readonly _tag: "none" }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "disproportionate" }
  | { readonly _tag: "match"; readonly find: string; readonly count: number }

/** Number of non-overlapping occurrences, matching `String.prototype.replaceAll`. */
export const countOccurrences = (content: string, search: string) => {
  if (search === "") return Array.from(content).length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

/**
 * Whether `search` occurs exactly once. Stepping the search past the first index
 * also catches self-overlapping patterns such as `"aaa"` / `"aa"`, which the V1
 * tool treated as ambiguous rather than silently replacing the first match.
 */
export const isUniqueOccurrence = (content: string, search: string) => {
  const first = content.indexOf(search)
  if (first < 0) return false
  return content.indexOf(search, first + 1) === -1
}

/** The first occurrence that begins a line, or `-1` for a mid-line first hit. */
export const firstLineAnchoredIndex = (content: string, search: string) => {
  const index = content.indexOf(search)
  if (index < 0) return -1
  return index === 0 || content[index - 1] === "\n" ? index : -1
}

export const isDisproportionateMatch = (search: string, oldString: string) => {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  const searchLength = Array.from(search.trim()).length
  const oldLength = Array.from(oldString.trim()).length
  return searchLength > Math.max(oldLength + 500, oldLength * 4)
}

const levenshtein = (a: string, b: string) => {
  const left = Array.from(a)
  const right = Array.from(b)
  if (left.length === 0 || right.length === 0) return Math.max(left.length, right.length)
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

const sliceSpan = (content: string, lines: string[], startLine: number, endLine: number) => {
  let start = 0
  for (let index = 0; index < startLine; index++) start += (lines[index] ?? "").length + 1
  let end = start
  for (let index = startLine; index <= endLine; index++) {
    end += (lines[index] ?? "").length
    if (index < endLine) end += 1
  }
  return content.slice(start, end)
}

/** Matches whole lines, ignoring each line's leading and trailing whitespace. */
const lineTrimmed = (content: string, find: string) => {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  if (searchLines.length === 0 || searchLines.length > originalLines.length) return []
  const out: string[] = []
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    const matches = searchLines.every((line, j) => (originalLines[i + j] ?? "").trim() === line.trim())
    if (matches) out.push(sliceSpan(content, originalLines, i, i + searchLines.length - 1))
  }
  return out
}

/** Matches by the first and last trimmed lines, scoring the middle by similarity. */
const blockAnchor = (content: string, find: string) => {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return []
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  if (searchLines.length < 2) return []

  const firstLine = searchLines[0].trim()
  const lastLine = searchLines[searchLines.length - 1].trim()
  const searchBlock = searchLines.length
  const maxDelta = Math.max(1, Math.floor(searchBlock / 4))

  const candidates: Array<[number, number]> = []
  for (let i = 0; i < originalLines.length; i++) {
    if ((originalLines[i] ?? "").trim() !== firstLine) continue
    let j = i + 2
    while (j < originalLines.length) {
      if ((originalLines[j] ?? "").trim() === lastLine) {
        if (Math.abs(j - i + 1 - searchBlock) <= maxDelta) candidates.push([i, j])
        break
      }
      j++
    }
  }
  if (candidates.length === 0) return []

  const similarityOf = (startLine: number, endLine: number) => {
    const actualBlock = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlock - 2, actualBlock - 2)
    if (linesToCheck <= 0) return 1
    let similarity = 0
    let j = 1
    while (j < searchBlock - 1 && j < actualBlock - 1) {
      const original = (originalLines[startLine + j] ?? "").trim()
      const search = (searchLines[j] ?? "").trim()
      const maxLength = Math.max(Array.from(original).length, Array.from(search).length)
      if (maxLength !== 0) similarity += 1 - levenshtein(original, search) / maxLength
      j++
    }
    return similarity / linesToCheck
  }

  if (candidates.length === 1) {
    const [start, end] = candidates[0]
    return similarityOf(start, end) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD
      ? [sliceSpan(content, originalLines, start, end)]
      : []
  }

  let best: [number, number] | undefined
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const similarity = similarityOf(candidate[0], candidate[1])
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      best = candidate
    }
  }
  return maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && best
    ? [sliceSpan(content, originalLines, best[0], best[1])]
    : []
}

/** Matches after collapsing runs of whitespace, including across line breaks. */
const whitespaceNormalized = (content: string, find: string) => {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const lines = content.split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      out.push(line)
      continue
    }
    if (!normalize(line).includes(normalizedFind)) continue
    const words = find.trim().split(/\s+/)
    if (words.length === 0) continue
    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
    const match = line.match(new RegExp(pattern))
    if (match) out.push(match[0])
  }
  const findLines = find.split("\n")
  if (findLines.length > 1 && findLines.length <= lines.length) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n")
      if (normalize(block) === normalizedFind) out.push(block)
    }
  }
  return out
}

/** Matches blocks after removing the indentation every non-empty line shares. */
const indentationFlexible = (content: string, find: string) => {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((line) => line.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length))
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }
  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  if (findLines.length === 0 || findLines.length > contentLines.length) return []
  const out: string[] = []
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) out.push(block)
  }
  return out
}

/** Matches after unescaping literal `\n`, `\t`, ... sequences in the search. */
const escapeNormalized = (content: string, find: string) => {
  const unescape = (text: string) =>
    text.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_match, character: string) => {
      switch (character) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        default:
          return character
      }
    })
  const unescapedFind = unescape(find)
  const out: string[] = []
  if (content.includes(unescapedFind)) out.push(unescapedFind)
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")
  if (findLines.length > 0 && findLines.length <= lines.length) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n")
      if (unescape(block) === unescapedFind) out.push(block)
    }
  }
  return out
}

/** Matches after trimming the search's leading and trailing whitespace. */
const trimmedBoundary = (content: string, find: string) => {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return []
  const out: string[] = []
  if (content.includes(trimmedFind)) out.push(trimmedFind)
  const lines = content.split("\n")
  const findLines = find.split("\n")
  if (findLines.length > 0 && findLines.length <= lines.length) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n")
      if (block.trim() === trimmedFind) out.push(block)
    }
  }
  return out
}

/** Matches blocks with the same anchors when at least half the middle lines agree. */
const contextAware = (content: string, find: string) => {
  const findLines = find.split("\n")
  if (findLines.length < 3) return []
  if (findLines[findLines.length - 1] === "") findLines.pop()
  if (findLines.length < 2) return []
  const contentLines = content.split("\n")
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] ?? "").trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if ((contentLines[j] ?? "").trim() !== lastLine) continue
      const blockLines = contentLines.slice(i, j + 1)
      if (blockLines.length === findLines.length) {
        let matching = 0
        let total = 0
        for (let k = 1; k < blockLines.length - 1; k++) {
          const blockLine = (blockLines[k] ?? "").trim()
          const findLine = (findLines[k] ?? "").trim()
          if (blockLine.length === 0 && findLine.length === 0) continue
          total++
          if (blockLine === findLine) matching++
        }
        if (total === 0 || matching / total >= 0.5) return [blockLines.join("\n")]
      }
      break
    }
  }
  return []
}

/**
 * Every candidate the restored V1 strategies produce, in strategy order. The
 * list is empty for an all-whitespace search, which cannot be a meaningful edit.
 */
export const fuzzyCandidates = (content: string, find: string) => {
  if (find.trim() === "") return []
  return [
    ...lineTrimmed(content, find),
    ...blockAnchor(content, find),
    ...whitespaceNormalized(content, find),
    ...indentationFlexible(content, find),
    ...escapeNormalized(content, find),
    ...trimmedBoundary(content, find),
    ...contextAware(content, find),
  ]
}

/**
 * Safe fuzzy policy shared by the TypeScript and native backends: the first
 * line-anchored candidate wins, unless it is disproportionate or ambiguous.
 * When candidates exist but are all ambiguous the result is `ambiguous`; when
 * only mid-line or absent candidates remain the result is `none`.
 */
export const fuzzyPlan = (content: string, find: string, replaceAll: boolean): Result => {
  let sawAmbiguous = false
  for (const candidate of fuzzyCandidates(content, find)) {
    if (firstLineAnchoredIndex(content, candidate) < 0) continue
    if (isDisproportionateMatch(candidate, find)) return { _tag: "disproportionate" }
    if (replaceAll) return { _tag: "match", find: candidate, count: countOccurrences(content, candidate) }
    if (isUniqueOccurrence(content, candidate)) return { _tag: "match", find: candidate, count: 1 }
    sawAmbiguous = true
  }
  return sawAmbiguous ? { _tag: "ambiguous" } : { _tag: "none" }
}

/**
 * Finds the region of `text` that `search` most likely refers to when an exact
 * match fails, tolerating whitespace and indentation differences while keeping
 * the V2 safety policy above. Returns the actual substring from `text`.
 */
export const matchFuzzy = (text: string, search: string): string | undefined => {
  const result = fuzzyPlan(text, search, false)
  return result._tag === "match" ? result.find : undefined
}
