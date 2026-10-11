import { baselineContract } from "./baseline"

export interface BaselineSample {
  task: string
  engine: "typescript" | "rust"
  repetition: number
  suiteHash: string
  taskHash: string
  profile: {
    model: string
    modelParametersHash: string
    agentManifestHash: string
    permissionHash: string
    toolSurfaceHash: string
  }
  revision: string
  artifactHash: string
  receiptHash: string
  outcome: "passed" | "failed" | "unverified"
  elapsedMs: number
  attempts: Array<{ inputTokens: number | null; outputTokens: number | null; cost: number | null }>
}

/** Summarize every attempt without turning missing usage into zero. */
export function summarizeBaseline(samples: BaselineSample[]) {
  const contract = baselineContract()
  const known = new Map(contract.tasks.map((task) => [task.id, task.taskHash]))
  const ids = new Set<string>()
  for (const sample of samples) {
    const id = `${sample.engine}:${sample.task}:${sample.repetition}`
    if (ids.has(id)) throw new Error(`Duplicate baseline sample: ${id}`)
    ids.add(id)
    if (sample.engine !== "typescript" && sample.engine !== "rust") throw new Error(`Unknown baseline engine: ${id}`)
    if (!["passed", "failed", "unverified"].includes(sample.outcome)) throw new Error(`Unknown baseline outcome: ${id}`)
    if (sample.suiteHash !== contract.suiteHash || sample.taskHash !== known.get(sample.task))
      throw new Error(`Fixture contract mismatch: ${id}`)
    if (!Number.isSafeInteger(sample.repetition) || sample.repetition < 0) throw new Error(`Invalid repetition: ${id}`)
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 || sample.attempts.length === 0)
      throw new Error(`Missing execution accounting: ${id}`)
    const hashes = [
      sample.profile.modelParametersHash,
      sample.profile.agentManifestHash,
      sample.profile.permissionHash,
      sample.profile.toolSurfaceHash,
      sample.artifactHash,
      sample.receiptHash,
    ]
    if (
      !hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)) ||
      !/^[a-f0-9]{40}$/.test(sample.revision) ||
      !sample.profile.model
    )
      throw new Error(`Missing baseline provenance: ${id}`)
    for (const attempt of sample.attempts) {
      if (
        [attempt.inputTokens, attempt.outputTokens].some(
          (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
        ) ||
        (attempt.cost !== null && (!Number.isFinite(attempt.cost) || attempt.cost < 0))
      )
        throw new Error(`Invalid attempt accounting: ${id}`)
    }
  }
  const groups = ["typescript", "rust"].map((engine) => {
    const runs = samples.filter((sample) => sample.engine === engine)
    const attempts = runs.flatMap((run) => run.attempts)
    const latencies = runs.map((run) => run.elapsedMs).toSorted((left, right) => left - right)
    const total = (key: "inputTokens" | "outputTokens" | "cost") =>
      attempts.length && attempts.every((attempt) => attempt[key] !== null)
        ? attempts.reduce((sum, attempt) => sum + (attempt[key] ?? 0), 0)
        : null
    const successfulAttempts = runs.filter((run) => run.outcome === "passed").flatMap((run) => run.attempts)
    return {
      engine,
      runs: runs.length,
      passed: runs.filter((run) => run.outcome === "passed").length,
      failed: runs.filter((run) => run.outcome === "failed").length,
      unverified: runs.filter((run) => run.outcome === "unverified").length,
      attempts: attempts.length,
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
      cost: total("cost"),
      successfulAttemptTokens:
        successfulAttempts.length &&
        successfulAttempts.every((attempt) => attempt.inputTokens !== null && attempt.outputTokens !== null)
          ? successfulAttempts.reduce(
              (sum, attempt) => sum + (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0),
              0,
            )
          : null,
      p50ElapsedMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
      p95ElapsedMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    }
  })
  const pairs = samples
    .filter((sample) => sample.engine === "typescript")
    .map((expected) => {
      const actual = samples.find(
        (sample) =>
          sample.engine === "rust" && sample.task === expected.task && sample.repetition === expected.repetition,
      )
      return {
        task: expected.task,
        repetition: expected.repetition,
        paired: Boolean(actual),
        comparable: Boolean(
          actual &&
            Object.entries(expected.profile).every(
              ([key, value]) => actual.profile[key as keyof BaselineSample["profile"]] === value,
            ),
        ),
        verified: Boolean(actual && expected.outcome !== "unverified" && actual.outcome !== "unverified"),
      }
    })
  const repetitions = [...new Set(samples.map((sample) => sample.repetition))]
  const covered =
    repetitions.length > 0 &&
    repetitions.every((repetition) =>
      contract.tasks.every((task) => pairs.some((pair) => pair.task === task.id && pair.repetition === repetition)),
    )
  const balanced = pairs.length > 0 && pairs.length * 2 === samples.length && pairs.every((pair) => pair.paired)
  return {
    version: 1,
    suiteHash: contract.suiteHash,
    groups,
    pairs,
    fullSuiteComparable: covered && balanced && pairs.every((pair) => pair.comparable && pair.verified),
    // Actual-client/ownership/history/rollback gates are not implied by metrics.
    defaultSwitchEligible: false,
  }
}

export * as EngineBaselineReport from "./baseline-report"
