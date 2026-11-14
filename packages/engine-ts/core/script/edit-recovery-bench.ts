/**
 * Offline recovery-rate sweep for stale-edit rebase (docs/edit-recovery.md).
 * Run from packages/core: bun script/edit-recovery-bench.ts
 */
import fs from "node:fs"
import path from "node:path"
import { EditMatch } from "../src/tool/edit-match"
import { EditRecovery } from "../src/tool/edit-recovery"

const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const corpus = (): string[] => {
  const root = path.resolve(import.meta.dir, "../src")
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts") && files.length < 40) {
        const text = fs.readFileSync(full, "utf8")
        const lines = text.split("\n")
        if (lines.length >= 40 && lines.length <= 400) files.push(text)
      }
    }
  }
  walk(root)
  return files
}

const countOccurrences = (text: string, needle: string) => {
  let count = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++
  return count
}

const main = () => {
  const random = rng(20261007)
  const files = corpus()
  let scenarios = 0
  let failures = 0
  let fuzzyRescued = 0
  let recovered = 0
  let misapplied = 0
  const refusals: Record<string, number> = {}

  for (const original of files) {
    const lines = original.split("\n")
    for (let round = 0; round < 2; round++) {
      const blockStart = 8 + Math.floor(random() * (lines.length - 24))
      const blockEnd = blockStart + 5
      const block = lines.slice(blockStart, blockEnd + 1).join("\n")
      const prevLine = lines[blockStart - 1]
      const mutated = [...lines]
      const drift = [`// drift ${Math.floor(random() * 1e6)} a`, `// drift ${Math.floor(random() * 1e6)} b`]
      const family = round
      if (family === 0) {
        // Insertion inside the quoted span: oldString spans the previous line
        // plus the block, and the drift lands between them.
        mutated.splice(blockStart, 0, ...drift)
        const oldString = `${prevLine}\n${block}`
        if (countOccurrences(original, oldString) !== 1) continue
        scenarios++
        evaluate(original, mutated.join("\n"), oldString)
      } else {
        // The block itself was rewritten in place; the quoted block is gone.
        for (let i = blockStart; i <= blockEnd; i++)
          mutated[i] = `${lines[i].replace(/\bconst\b/g, "let").replace(/\d+/g, (n) => `${n}7`)} // drifted`
        const oldString = block
        if (mutated.slice(blockStart, blockEnd + 1).join("\n").includes(oldString)) continue
        scenarios++
        evaluate(original, mutated.join("\n"), oldString)
      }
    }
  }

  function evaluate(original: string, current: string, oldString: string) {
    const matched = EditMatch.matchTs(current, oldString, false)
    if (matched._tag === "match") {
      fuzzyRescued++
      return
    }
    failures++
    const newString = `// rebase bench\nconst benchReplaced = ${failures}\n`
    const outcome = EditRecovery.recover({ snapshot: original, current, oldString, newString })
    if (outcome._tag !== "recovered") {
      refusals[outcome._tag === "refused" ? outcome.reason : outcome._tag] =
        (refusals[outcome._tag === "refused" ? outcome.reason : outcome._tag] ?? 0) + 1
      return
    }
    recovered++
    // Independent region check: re-derive the anchors with a plain outward scan
    // and require the outcome to be exactly that splice.
    const snapshotLines = original.split("\n")
    const currentLines = current.split("\n")
    const first = original.indexOf(oldString)
    const start = original.slice(0, first).split("\n").length - 1
    const end = start + oldString.split("\n").length - 1
    const findAnchor = (from: number, step: number) => {
      for (let line = from; line >= 0 && line < snapshotLines.length && Math.abs(from - line) < 3; line += step) {
        const text = snapshotLines[line]
        if (text.trim() === "" || countOccurrences(current, text) !== 1) continue
        return currentLines.indexOf(text)
      }
      return undefined
    }
    const above = findAnchor(start - 1, -1)
    const below = findAnchor(end + 1, 1)
    const from = above === undefined ? 0 : above + 1
    const to = below === undefined ? currentLines.length : below
    const expected = [...currentLines.slice(0, from), ...newString.split("\n"), ...currentLines.slice(to)].join("\n")
    if (outcome.replaced !== expected) misapplied++
  }

  const rate = failures === 0 ? 1 : recovered / failures
  console.log(`files=${files.length} scenarios=${scenarios} exactOrFuzzyOk=${fuzzyRescued} failures=${failures}`)
  console.log(`recovered=${recovered} recoveryRate=${(rate * 100).toFixed(1)}% refusals=${JSON.stringify(refusals)} misapplied=${misapplied}`)
  console.log(`GATE recoveryRate>=60% misapplied=0 -> ${rate >= 0.6 && misapplied === 0 ? "PASS" : "FAIL"}`)
}

main()
