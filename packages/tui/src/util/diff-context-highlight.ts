import { getTreeSitterClient, type TreeSitterClient } from "@opentui/core"
import { parsePatch } from "diff"

type Highlights = NonNullable<Awaited<ReturnType<TreeSitterClient["highlightOnce"]>>["highlights"]>
type Side = "old" | "new"
type Source = { side: Side; line: number; text: string; removed?: boolean } | undefined

// Deleted code is shown as plain text; the current side retains syntax colors.
export function createDiffHighlighter(input: { patch: string; current?: string }) {
  const views = sourceMaps(parsePatch(input.patch)[0]?.hunks ?? [])
  const base =
    (input.current === undefined ? undefined : createDiffContextHighlighter({ patch: input.patch, current: input.current })) ??
    getTreeSitterClient()
  const client: TreeSitterClient = Object.create(base)
  client.highlightOnce = async (content, filetype) => {
    const result = await base.highlightOnce(content, filetype)
    const lines = content.split("\n")
    const map = views.find(
      (view) => view.length === lines.length && view.every((source, index) => (source?.text ?? "") === lines[index]),
    )
    if (!map) return result
    const bucket = bucketByLine(result.highlights ?? [], content)
    return {
      ...result,
      highlights: map.flatMap((source, index): Highlights => {
        const start = bucket.starts[index]
        const end = start + lines[index].length
        if (source?.removed) return end > start ? [[start, end, "diff.removed.text"]] : []
        return (bucket.lines[index] ?? []).map((highlight) => [
          Math.max(highlight[0], start),
          Math.min(highlight[1], end),
          highlight[2],
          highlight[3],
        ])
      }),
    }
  }
  return client
}

// The diff renderer joins the visible hunk lines into one snippet and
// highlights that in isolation. A hunk that starts inside a block comment or a
// multi-line string then parses as broken code and loses most highlighting.
// This client highlights the whole file on each side instead and maps the
// result back onto the snippet. It needs the file as it is now; when the file
// no longer matches the patch it returns undefined and the caller keeps the
// default client.
export function createDiffContextHighlighter(input: { patch: string; current: string }) {
  const hunks = parsePatch(input.patch)[0]?.hunks ?? []
  if (hunks.length === 0) return undefined
  const sources = reconstructSources(hunks, input.current)
  if (!sources) return undefined

  const views = sourceMaps(hunks)
  const sourceLines = { old: sources.old.split("\n"), new: sources.new.split("\n") }
  const base = getTreeSitterClient()
  const full = new Map<string, Promise<Highlights>>()
  const highlightSide = (side: Side, filetype: string) => {
    const key = `${side}:${filetype}`
    const cached = full.get(key)
    if (cached) return cached
    const next = base.highlightOnce(sources[side], filetype).then((result) => result.highlights ?? [])
    full.set(key, next)
    return next
  }

  const client: TreeSitterClient = Object.create(base)
  client.highlightOnce = async (content, filetype) => {
    const lines = content.split("\n")
    const map = views.find(
      (view) =>
        view.length === lines.length &&
        view.every((source, index) =>
          source ? sourceLines[source.side][source.line - 1] === lines[index] : lines[index] === "",
        ),
    )
    if (!map) return base.highlightOnce(content, filetype)
    const byLine = {
      old: bucketByLine(await highlightSide("old", filetype), sources.old),
      new: bucketByLine(await highlightSide("new", filetype), sources.new),
    }
    const offsets = lines.reduce<number[]>((result, line, index) => {
      result.push(index === 0 ? 0 : result[index - 1] + lines[index - 1].length + 1)
      return result
    }, [])
    return {
      highlights: map.flatMap((source, index) => {
        if (!source) return []
        const bucket = byLine[source.side]
        const start = bucket.starts[source.line - 1]
        const end = start + lines[index].length
        return (bucket.lines[source.line - 1] ?? []).map((highlight): Highlights[number] => {
          const next: Highlights[number] = [...highlight]
          next[0] = Math.max(highlight[0], start) - start + offsets[index]
          next[1] = Math.min(highlight[1], end) - start + offsets[index]
          return next
        })
      }),
    }
  }
  return client
}

type Hunk = ReturnType<typeof parsePatch>[number]["hunks"][number]

// Rebuild both sides from the current file: the new side is the file itself
// once every hunk's context and added lines are confirmed at their positions,
// and the old side swaps each hunk's new range for its context and removed lines.
function reconstructSources(hunks: Hunk[], current: string) {
  const lines = current.split("\n")
  const matches = hunks.every((hunk) => {
    if (hunk.newLines === 0) return false
    const expected = hunk.lines.filter((line) => line[0] === " " || line[0] === "+").map((line) => line.slice(1))
    return expected.every((line, index) => lines[hunk.newStart - 1 + index] === line)
  })
  if (!matches) return undefined
  const old: string[] = []
  const cursor = hunks.reduce((position, hunk) => {
    old.push(...lines.slice(position, hunk.newStart - 1))
    old.push(...hunk.lines.filter((line) => line[0] === " " || line[0] === "-").map((line) => line.slice(1)))
    return hunk.newStart - 1 + hunk.newLines
  }, 0)
  old.push(...lines.slice(cursor))
  return { old: old.join("\n"), new: current }
}

// Line order for each layout the renderer can ask about: the unified view and
// the two columns of the split view, which pad unequal change runs with blanks.
function sourceMaps(hunks: Hunk[]) {
  const unified: Source[] = []
  const left: Source[] = []
  const right: Source[] = []
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    let removes: Source[] = []
    let adds: Source[] = []
    const flush = () => {
      const length = Math.max(removes.length, adds.length)
      left.push(...removes, ...Array.from({ length: length - removes.length }, () => undefined))
      right.push(...adds, ...Array.from({ length: length - adds.length }, () => undefined))
      removes = []
      adds = []
    }
    for (const line of hunk.lines) {
      if (line[0] === " ") {
        flush()
        unified.push({ side: "new", line: newLine, text: line.slice(1) })
        left.push({ side: "old", line: oldLine, text: line.slice(1) })
        right.push({ side: "new", line: newLine, text: line.slice(1) })
        oldLine++
        newLine++
      }
      if (line[0] === "-") {
        unified.push({ side: "old", line: oldLine, text: line.slice(1), removed: true })
        removes.push({ side: "old", line: oldLine, text: line.slice(1), removed: true })
        oldLine++
      }
      if (line[0] === "+") {
        unified.push({ side: "new", line: newLine, text: line.slice(1) })
        adds.push({ side: "new", line: newLine, text: line.slice(1) })
        newLine++
      }
    }
    flush()
  }
  return [unified, left, right]
}

function bucketByLine(highlights: Highlights, text: string) {
  const starts = text.split("\n").reduce<number[]>((result, line, index, all) => {
    result.push(index === 0 ? 0 : result[index - 1] + all[index - 1].length + 1)
    return result
  }, [])
  const lines: Highlights[] = []
  for (const highlight of highlights) {
    const first = lineAt(starts, highlight[0])
    const last = lineAt(starts, Math.max(highlight[0], highlight[1] - 1))
    for (let line = first; line <= last; line++) (lines[line] ??= []).push(highlight)
  }
  return { starts, lines }
}

function lineAt(starts: number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}
