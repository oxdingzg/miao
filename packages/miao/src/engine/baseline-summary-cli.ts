import { readdir } from "node:fs/promises"
import path from "node:path"
import type { BaselineEvidence } from "./baseline-run"

/**
 * Summarizes a sweep's evidence directory into one row per engine and task:
 * pass rate, latency, provider turns, tokens, tool calls, receipts, and loop
 * classifications. It is the reporting view the roadmap asks for across a
 * wider task set than the phase-latency CLI covers.
 *
 * Reading tokens cannot be split out of the per-attempt totals -- the engine
 * accounts usage per provider turn, not per tool -- so the table reports tool
 * calls as the retrieval-effort proxy and says so.
 */

const directory = Bun.argv.slice(2).find((argument) => !argument.startsWith("--"))
if (!directory) {
  console.error("usage: baseline-summary-cli EVIDENCE_DIR")
  process.exit(2)
}

const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
const runs: { evidence: BaselineEvidence; outcome: string | null }[] = []
for (const file of files) {
  const parsed = await Bun.file(path.join(directory, file)).json()
  if (parsed.evidence) runs.push({ evidence: parsed.evidence, outcome: parsed.sample?.outcome ?? null })
}

const groups = new Map<string, typeof runs>()
for (const run of runs) {
  const key = `${run.evidence.engine}\u0000${run.evidence.task}`
  groups.set(key, [...(groups.get(key) ?? []), run])
}

console.log(
  "| engine | task | passed | p50 | turns/run | input tokens | output tokens | tools/run | receipts | loops |",
)
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for (const [key, entries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const [engine, task] = key.split("\u0000")
  const total = entries.length
  const passed = entries.filter((entry) => entry.outcome === "passed").length
  const latencies = entries.map((entry) => entry.evidence.elapsedMs).sort((left, right) => left - right)
  const turns = entries.reduce((sum, entry) => sum + entry.evidence.attempts.length, 0)
  const input = entries.reduce(
    (sum, entry) => sum + entry.evidence.attempts.reduce((inner, attempt) => inner + (attempt.inputTokens ?? 0), 0),
    0,
  )
  const output = entries.reduce(
    (sum, entry) => sum + entry.evidence.attempts.reduce((inner, attempt) => inner + (attempt.outputTokens ?? 0), 0),
    0,
  )
  const tools = entries.reduce((sum, entry) => sum + entry.evidence.toolCalls, 0)
  const receipts = [
    ...new Set(entries.flatMap((entry) => entry.evidence.receipts)),
  ].sort()
  const loops = [
    ...new Set(entries.flatMap((entry) => [...entry.evidence.loops.continuations, ...entry.evidence.loops.stopped])),
  ].sort()
  console.log(
    `| ${engine} | ${task} | ${passed}/${total} | ${latencies[Math.ceil(latencies.length * 0.5) - 1] ?? 0} ms | ` +
      `${(turns / total).toFixed(1)} | ${input} | ${output} | ${(tools / total).toFixed(1)} | ` +
      `${receipts.join(", ") || "-"} | ${loops.join(", ") || "-"} |`,
  )
}