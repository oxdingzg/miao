import { BenchHarness } from "./lib/harness"
import { suite as requestPreparation } from "./request-preparation"

const suites = [requestPreparation]

const only = BenchHarness.samplePath()
if (only !== undefined) {
  const measurement = suites
    .flatMap((suite) => suite.measurements.map((entry) => ({ id: `${suite.name}/${entry.name}`, entry })))
    .find((candidate) => candidate.id === only)
  if (measurement === undefined) throw new Error(`Unknown benchmark: ${only}`)
  await BenchHarness.sample(measurement.entry)
} else {
  await BenchHarness.run(suites)
}
