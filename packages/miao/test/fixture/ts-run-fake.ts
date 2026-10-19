#!/usr/bin/env bun
// A scripted `miao run` stand-in for the baseline harness. It emits the JSON
// lines the runner reads and records the provider interaction the effective
// profile is derived from, so the TypeScript leg can be exercised end to end
// without a provider.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { BlackboxTape } from "@miao/core/blackbox/tape"

const session = "ses_baseline_fixture"
const answer = "src/catalog.ts exports configureRelay with capacity 7"
const bundle = {
  format: "miao-blackbox" as const,
  version: 1 as const,
  metadata: {},
  interactions: [
    {
      lane: "llm",
      ordinal: 0,
      request: {
        model: { id: "fixture-model" },
        execution: { agentManifestHash: "b".repeat(64), permissionHash: "c".repeat(64) },
        tools: [],
      },
      frames: [{ elapsedMs: 1, value: { type: "finish", usage: { inputTokens: 120, outputTokens: 12 } } }],
      outcome: "complete" as const,
      endElapsedMs: 2,
    },
  ],
  trace: [],
}

const directory = process.env.MIAO_BLACKBOX_RECORD
if (directory) {
  await mkdir(directory, { recursive: true })
  await Bun.write(
    path.join(directory, `${session}.json`),
    JSON.stringify({ bundle, sha256: BlackboxTape.digest(bundle) }),
  )
}

console.log(JSON.stringify({ type: "step_start", sessionID: session, timestamp: Date.now() }))
console.log(
  JSON.stringify({ type: "text", sessionID: session, timestamp: Date.now(), part: { type: "text", text: answer } }),
)
