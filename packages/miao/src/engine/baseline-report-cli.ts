import { Schema } from "effect"
import { EngineBaselineReport } from "./baseline-report"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Sample = Schema.Struct({
  task: Schema.String,
  engine: Schema.Literals(["typescript", "rust"]),
  repetition: Schema.Number,
  suiteHash: Hash,
  taskHash: Hash,
  profile: Schema.Struct({
    model: Schema.String,
    modelParametersHash: Hash,
    agentManifestHash: Hash,
    permissionHash: Hash,
    toolSurfaceHash: Hash,
  }),
  revision: Schema.String,
  artifactHash: Hash,
  receiptHash: Hash,
  outcome: Schema.Literals(["passed", "failed", "unverified"]),
  elapsedMs: Schema.Number,
  attempts: Schema.Array(
    Schema.Struct({
      inputTokens: Schema.NullOr(Schema.Number),
      outputTokens: Schema.NullOr(Schema.Number),
      cost: Schema.NullOr(Schema.Number),
    }),
  ),
})
const file = Bun.argv[2]
if (!file) throw new Error("Usage: bun src/engine/baseline-report-cli.ts samples.json")
const samples = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Array(Sample))))(
  await Bun.file(file).text(),
)
const report = EngineBaselineReport.summarizeBaseline(
  [...samples].map((sample) => ({ ...sample, attempts: [...sample.attempts] })),
)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.fullSuiteComparable ? 0 : 1
