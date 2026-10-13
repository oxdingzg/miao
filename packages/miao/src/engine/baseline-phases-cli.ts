import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import type { BaselineEvidence } from "./baseline-run"

/**
 * Summarizes the phase-latency evidence written by baseline-sweep-cli: per
 * engine and task it reports admission-to-first-output, output-to-terminal,
 * terminal-to-verified, and total wall clock at p50/p95, plus the median
 * provider attempts and tool calls. Runs without a terminal or a first output
 * stay unknown instead of being dropped into zero.
 */

const args = Bun.argv.slice(2)
const directory = args.find((argument) => !argument.startsWith("--"))
if (!directory) {
  console.error("usage: baseline-phases-cli EVIDENCE_DIR")
  process.exit(2)
}
const json = args.includes("--json")

const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
const runs = (
  await Promise.all(
    files.map(async (file) => {
      const target = path.join(directory, file)
      if (!(await stat(target)).isFile()) return []
      const parsed = (await Bun.file(target).json()) as { evidence?: BaselineEvidence }
      return parsed.evidence ? [parsed.evidence] : []
    }),
  )
).flat()

const groups = new Map<string, BaselineEvidence[]>()
for (const run of runs) {
  const key = `${run.engine}\u0000${run.task}`
  groups.set(key, [...(groups.get(key) ?? []), run])
}

const summary = [...groups.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, entries]) => {
    const [engine, task] = key.split("\u0000")
    const firstOutput = entries.map(firstOutputDelay).filter(isNumber)
    const toTerminal = entries
      .map((entry) => span(terminalAt(entry), firstOutputAt(entry)))
      .filter(isNumber)
    const toVerified = entries.map((entry) => span(verifiedAt(entry), terminalAt(entry))).filter(isNumber)
    return {
      engine,
      task,
      runs: entries.length,
      firstOutputMs: percentile(firstOutput),
      outputToTerminalMs: percentile(toTerminal),
      terminalToVerifiedMs: percentile(toVerified),
      totalMs: percentile(entries.map((entry) => entry.elapsedMs)),
      attempts: median(entries.map((entry) => entry.attempts.length)),
      toolCalls: median(entries.map((entry) => entry.toolCalls)),
    }
  })

if (json) {
  console.log(JSON.stringify({ version: 1, runs: runs.length, groups: summary }, null, 2))
} else {
  for (const group of summary)
    console.log(
      `${group.engine}/${group.task} runs=${group.runs} ` +
        `first-output=${format(group.firstOutputMs)} out->terminal=${format(group.outputToTerminalMs)} ` +
        `terminal->verified=${format(group.terminalToVerifiedMs)} total=${format(group.totalMs)} ` +
        `attempts=${group.attempts ?? "-"} tools=${group.toolCalls ?? "-"}`,
    )
}

function firstOutputAt(evidence: BaselineEvidence) {
  return evidence.phases
    .filter((phase) => phase.phase === "first-output")
    .map((phase) => phase.atMs)
    .sort((left, right) => left - right)[0]
}

function firstOutputDelay(evidence: BaselineEvidence) {
  const first = firstOutputAt(evidence)
  if (first === undefined) return undefined
  return first - (evidence.admissionMs ?? evidence.startedAtMs)
}

function terminalAt(evidence: BaselineEvidence) {
  return evidence.phases
    .filter((phase) => ["run.finished", "stop", "exit"].includes(phase.phase))
    .map((phase) => phase.atMs)
    .sort((left, right) => right - left)[0]
}

function verifiedAt(evidence: BaselineEvidence) {
  return evidence.phases.filter((phase) => phase.phase === "verified").map((phase) => phase.atMs)[0]
}

function span(until: number | undefined, from: number | undefined) {
  if (until === undefined || from === undefined) return undefined
  return until - from
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

function percentile(values: number[]) {
  if (values.length === 0) return { p50: null, p95: null, samples: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: sorted.length,
  }
}

function median(values: number[]) {
  if (values.length === 0) return null
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.5) - 1]
}

function format(value: { p50: number | null; p95: number | null; samples: number }) {
  return value.samples === 0 ? "n/a" : `p50=${value.p50}ms p95=${value.p95}ms n=${value.samples}`
}