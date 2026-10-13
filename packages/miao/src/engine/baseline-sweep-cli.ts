import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { baselineContract } from "./baseline"
import { runBaselineRust, runBaselineTs, type BaselineRun } from "./baseline-run"
import { summarizeBaseline, type BaselineSample } from "./baseline-report"

/**
 * Runs the frozen baseline suite against one engine and writes report samples
 * plus their evidence. One engine per invocation keeps provider contention and
 * failure attribution out of the measurement; summarize both engines' samples
 * together with baseline-report-cli.
 */

const USAGE = `usage: baseline-sweep-cli --engine rust|typescript --out DIR [options]

common:
  --tasks id,id,...         frozen tasks (default: all seven)
  --repetitions N           runs per task (default 1)
  --model MODEL             provider model (default openai/gpt-6.1-sol)
  --revision SHA40          source revision the engine was built from
  --timeout-ms N            per-run timeout (default 300000)
  --pause-ms N              pause between runs, e.g. to pace a provider (default 0)

rust:
  --binary PATH             miao-engine binary
  --provider NAME           provider protocol (e.g. subscription-responses)
  --policy FILE             policy override (default: protected/** deny contract)
  --endpoint URL            provider base URL override
  --edit-recovery on|off    stale-edit recovery ablation (default: on)
  --credential-db FILE      product credential database (read-only)
  --credential-id ID        credential row
  --credential-integration NAME

typescript:
  --entry PATH              packages/miao/src/index.ts of the checkout under test
  --bun PATH                bun executable (default: bun)
  --credential-db FILE      stable credential store to inherit (read-only)

rust only:
  --env-file FILE           extra engine environment JSON (research fixtures)
`

interface Options {
  engine: "rust" | "typescript"
  out: string
  tasks: string[]
  repetitions: number
  model: string
  revision: string
  timeoutMs: number
  pauseMs: number
  binary?: string
  provider?: string
  policy?: string
  endpoint?: string
  editRecovery?: boolean
  credentialDatabase?: string
  credentialID?: string
  credentialIntegration?: string
  entry?: string
  bun?: string
  envFile?: string
}

const args = Bun.argv.slice(2)
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(args.length === 0 ? 1 : 0)
}
const options = readOptions(args)
const env = options.envFile ? await Bun.file(options.envFile).json() : undefined
const binarySha256 =
  options.engine === "rust"
    ? new Bun.CryptoHasher("sha256").update(await Bun.file(options.binary!).arrayBuffer()).digest("hex")
    : undefined
await mkdir(options.out, { recursive: true })
await mkdir(path.join(options.out, "evidence"), { recursive: true })

const results: BaselineRun[] = []
let failed = 0
for (const task of options.tasks) {
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    if (options.pauseMs > 0 && results.length > 0) await Bun.sleep(options.pauseMs)
    const root = path.join(options.out, "runs", `${options.engine}-${task}-${repetition}`)
    const started = Date.now()
    const result =
      options.engine === "rust"
        ? await runBaselineRust({
            revision: options.revision,
            binary: options.binary!,
            root,
            task,
            repetition,
            model: options.model,
            provider: options.provider,
            policyFile: options.policy,
            endpoint: options.endpoint,
            editRecovery: options.editRecovery,
            credentialDatabase: options.credentialDatabase,
            credentialID: options.credentialID,
            credentialIntegration: options.credentialIntegration,
            timeoutMs: options.timeoutMs,
            env,
            binarySha256,
          })
        : await runBaselineTs({
            revision: options.revision,
            root,
            task,
            repetition,
            model: options.model,
            entry: options.entry!,
            bun: options.bun,
            credentialDatabase: options.credentialDatabase,
            timeoutMs: options.timeoutMs,
          })
    results.push(result)
    await Bun.write(
      path.join(options.out, "evidence", `${options.engine}-${task}-${repetition}.json`),
      JSON.stringify(
        {
          sample: result.sample,
          rejection: result.rejection,
          evidence: result.evidence,
          assessment: result.assessment,
          answer: result.answer,
        },
        null,
        2,
      ) + "\n",
    )
    if (!result.sample) failed++
    console.log(
      `[${options.engine}/${task}#${repetition}] ${result.sample?.outcome ?? "rejected:" + (result.rejection ?? "unknown")} ` +
        `elapsed=${result.evidence.elapsedMs}ms attempts=${result.evidence.attempts.length} ` +
        `tools=${result.evidence.toolCalls} receipts=${result.evidence.receipts.join("|") || "-"} ` +
        `wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    )
    await rm(root, { recursive: true, force: true })
  }
}

const samples: BaselineSample[] = results.flatMap((result) => (result.sample ? [result.sample] : []))
await Bun.write(path.join(options.out, "samples.json"), JSON.stringify(samples, null, 2) + "\n")
await Bun.write(
  path.join(options.out, "sweep.json"),
  JSON.stringify(
    {
      engine: options.engine,
      model: options.model,
      revision: options.revision,
      binary: options.binary ?? null,
      binarySha256: binarySha256 ?? null,
      tasks: options.tasks,
      repetitions: options.repetitions,
      suiteHash: baselineContract().suiteHash,
      startedAtMs: Math.min(...results.map((result) => result.evidence.startedAtMs)),
      finishedAtMs: Math.max(
        ...results.map((result) => result.evidence.startedAtMs + result.evidence.elapsedMs),
      ),
      samples: samples.length,
      rejected: results.length - samples.length,
    },
    null,
    2,
  ) + "\n",
)

if (samples.length > 0) {
  try {
    console.log(JSON.stringify(summarizeBaseline(samples), null, 2))
  } catch (error) {
    console.error(`samples failed report validation: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
process.exit(failed > 0 ? 1 : 0)

function readOptions(args: string[]): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`)
    values.set(key.slice(2), value)
  }
  const engine = values.get("engine")
  if (engine !== "rust" && engine !== "typescript") throw new Error("--engine must be rust or typescript")
  const out = values.get("out")
  if (!out) throw new Error("--out is required")
  const tasks = values.get("tasks")?.split(",") ?? baselineContract().tasks.map((task) => task.id)
  const contract = baselineContract()
  for (const task of tasks)
    if (!contract.tasks.some((entry) => entry.id === task)) throw new Error(`unknown task: ${task}`)
  const revision = values.get("revision") ?? defaultRevision()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("--revision must be a 40-hex source revision")
  if (engine === "rust" && !values.get("binary")) throw new Error("--binary is required for rust")
  if (engine === "typescript" && !values.get("entry")) throw new Error("--entry is required for typescript")
  return {
    engine,
    out,
    tasks,
    repetitions: Number(values.get("repetitions") ?? 1),
    model: values.get("model") ?? "openai/gpt-6.1-sol",
    revision,
    timeoutMs: Number(values.get("timeout-ms") ?? 300_000),
    pauseMs: Number(values.get("pause-ms") ?? 0),
    binary: values.get("binary"),
    provider: values.get("provider"),
    policy: values.get("policy"),
    endpoint: values.get("endpoint"),
    editRecovery: values.get("edit-recovery") === undefined ? undefined : values.get("edit-recovery") !== "off",
    credentialDatabase: values.get("credential-db"),
    credentialID: values.get("credential-id"),
    credentialIntegration: values.get("credential-integration"),
    entry: values.get("entry"),
    bun: values.get("bun"),
    envFile: values.get("env-file"),
  }
}

function defaultRevision() {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.resolve(import.meta.dir, "../../..") })
  const revision = head.stdout.toString().trim()
  if (!head.success || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error("--revision is required outside a git checkout")
  return revision
}