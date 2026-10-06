import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { distribution, markdown, parseStage, parseTurn, report, summarize } from "../src/baseline"

const line =
  "timestamp=2026-10-06T00:00:00.000Z message=session.turn sessionID=ses_example model=example/model local.preRequestMs=200 local.startSnapshotMs=50 local.endSnapshotMs=20 local.filesMs=10 ttftMs=800 turnMs=1500 warm=true cacheMiss=false cacheMissCause=none cacheHitRatio=0.8 tokens.input=100 tokens.cache.read=400"

test("parses flattened logfmt and excludes started events", () => {
  expect(parseTurn(line)?.["local.preRequestMs"]).toBe("200")
  expect(parseTurn(line.replace("message=session.turn", 'message="session.turn"'))?.model).toBe("example/model")
  expect(parseTurn(line.replace("message=session.turn", "message=session.turn.started"))).toBeUndefined()
  expect(parseTurn('message=other detail="message=session.turn"')).toBeUndefined()
})

test("keeps missing or invalid metrics separate from measured zero", () => {
  const result = summarize([
    parseTurn(line)!,
    parseTurn("message=session.turn local.preRequestMs=0 ttftMs=undefined turnMs=NaN tokens.input=-1")!,
    parseTurn("message=session.turn")!,
  ])
  expect(result.metrics["local.preRequestMs"]).toEqual({ n: 2, mean: 100, p50: 0, p90: 200, p99: 200, max: 200 })
  expect(result.metrics.ttftMs?.n).toBe(1)
  expect(result.tokens.input).toEqual({ n: 1, total: 100 })
  expect(result.warm).toEqual({ yes: 1, no: 0 })
  expect(result.snapshotTotalMs?.p50).toBe(80)
  expect(result.metrics["local.historyMs"]).toBeUndefined()
})

test("calculates percentiles on per-step snapshot sums, not sums of percentiles", () => {
  const result = summarize([
    parseTurn("message=session.turn local.startSnapshotMs=100 local.endSnapshotMs=0 local.filesMs=0")!,
    parseTurn("message=session.turn local.startSnapshotMs=0 local.endSnapshotMs=100 local.filesMs=0")!,
  ])
  expect(result.snapshotTotalMs?.p50).toBe(100)
  expect(distribution([])).toBeUndefined()
})

test("separates model and cache cohorts and documents measurement limits", () => {
  const result = report([
    parseTurn(line)!,
    parseTurn(line.replace("warm=true", "warm=false").replace("cacheMissCause=none", "cacheMissCause=cold"))!,
  ])
  expect(result.groups.length).toBe(2)
  expect(result.overall.sessions).toBe(1)
  expect(markdown(result)).toContain("工具定义 token 占比")
  expect(markdown(result)).toContain("不是纯 provider 时间")
})

test("CLI filters actual files and fails on an empty selection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miao-baseline-"))
  try {
    const file = path.join(dir, "sample.log")
    await Bun.write(file, `${line} run=run_a\n${line.replace("ses_example", "ses_other")} run=run_b\n`)
    const run = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../src/baseline.ts"),
        "--log",
        file,
        "--session",
        "ses_example",
        "--run",
        "run_a",
        "--since",
        "2026-10-06T00:00:00Z",
        "--until",
        "2026-10-06T00:00:00Z",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const output = await new Response(run.stdout).json()
    expect(await run.exited).toBe(0)
    expect(output.overall.turns).toBe(1)
    expect(output.groups[0].warmState).toBe("true")
    const empty = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "../src/baseline.ts"), "--log", file, "--model", "absent"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await empty.exited).not.toBe(0)
    expect(await new Response(empty.stderr).text()).toContain("No completed session.turn records")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("stage records parse into separate resolve and snapshot distributions", () => {
  const resolve =
    "timestamp=2026-10-06T00:00:01.000Z message=session.resolve sessionID=ses_example model=example/model selectionMs=5 connectionMs=40 credentialMs=120 totalMs=170"
  const snapshot =
    "timestamp=2026-10-06T00:00:02.000Z message=session.snapshot refreshMs=900 writeTreeMs=60 scopes=1"
  const stages = [parseStage(resolve)!, parseStage(snapshot)!, parseStage(line)!].filter(Boolean)
  expect(stages).toHaveLength(2)
  const result = report([parseTurn(line)!], stages)
  expect(result.stages.resolve.selectionMs).toEqual({ n: 1, mean: 5, p50: 5, p90: 5, p99: 5, max: 5 })
  expect(result.stages.resolve.totalMs?.max).toBe(170)
  expect(result.stages.snapshot.refreshMs?.n).toBe(1)
  expect(result.stages.snapshot.writeTreeMs?.p99).toBe(60)
  const text = markdown(report([parseTurn(line)!], stages))
  expect(text).toContain("resolve.credentialMs")
  expect(text).toContain("snapshot.refreshMs")
  expect(text).toContain("只记录 ≥500ms 的 capture")
})
