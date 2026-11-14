export * as BenchHarness from "./harness"

/**
 * A measured path. `body` runs once per sample in a fresh process, so a sample
 * cannot inherit another sample's warm JIT, module cache, or heap.
 */
export type Measurement = {
  readonly name: string
  /**
   * Median milliseconds expected on a developer machine. Reviewed source, not a
   * runtime knob: a budget that can be raised from the environment stops
   * guarding anything.
   */
  readonly referenceMs: number
  /** Bounds the ratio against another measurement of the same shape. */
  readonly scaling?: { readonly baseline: string; readonly maximum: number }
  readonly body: () => void | Promise<void>
}

export type Suite = {
  readonly name: string
  readonly measurements: ReadonlyArray<Measurement>
}

/**
 * Budgets are compared on continuous integration, whose runners are slower and
 * noisier than a developer machine: the reference is scaled by the machine
 * factor and then given headroom for one-off scheduler noise. `bench-report.yml`
 * prints the measured factor on every run so the constants can be tightened
 * against real numbers rather than guessed.
 */
const CI_SCALE = 3
const HEADROOM = 1.25
const SAMPLES = 5

const budget = (referenceMs: number) => referenceMs * CI_SCALE * HEADROOM

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

export const samplePath = () => {
  const index = process.argv.indexOf("--only")
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Runs one measurement in this process and prints its duration as JSON. */
export const sample = async (measurement: Measurement) => {
  const started = performance.now()
  await measurement.body()
  console.log(JSON.stringify({ ms: performance.now() - started }))
}

export const run = async (suites: ReadonlyArray<Suite>) => {
  const entry = process.argv[1]
  if (entry === undefined) throw new Error("benchmarks need an entry script")
  const results: Array<{ name: string; ms: number; budget: number; baseline?: number }> = []
  const failures: string[] = []
  for (const suite of suites) {
    for (const measurement of suite.measurements) {
      const id = `${suite.name}/${measurement.name}`
      const samples: number[] = []
      for (let index = 0; index < SAMPLES; index++) {
        const child = Bun.spawnSync([process.execPath, entry, "--only", id], { stdout: "pipe", stderr: "inherit" })
        if (child.exitCode !== 0) throw new Error(`${id} sample ${index + 1} exited ${child.exitCode}`)
        samples.push((JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as { ms: number }).ms)
      }
      const ms = median(samples)
      const allowed = budget(measurement.referenceMs)
      const baseline = results.find((result) => result.name === `${suite.name}/${measurement.scaling?.baseline}`)
      results.push({ name: id, ms, budget: allowed, baseline: baseline?.ms })
      if (ms > allowed) failures.push(`${id}: ${ms.toFixed(1)}ms over a ${allowed.toFixed(0)}ms budget`)
      const ratio = measurement.scaling && baseline !== undefined ? ms / baseline.ms : undefined
      if (ratio !== undefined && ratio > measurement.scaling!.maximum)
        failures.push(
          `${id}: ${ratio.toFixed(2)}x the small input, over the ${measurement.scaling!.maximum}x complexity bound`,
        )
    }
  }
  const width = Math.max(...results.map((result) => result.name.length))
  for (const result of results) {
    const ratio = result.baseline === undefined ? "" : ` (${(result.ms / result.baseline).toFixed(2)}x small)`
    console.log(
      `${result.name.padEnd(width)}  ${result.ms.toFixed(1).padStart(7)}ms  budget ${result.budget.toFixed(0).padStart(6)}ms${ratio}`,
    )
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} budget violation(s):`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  }
}
