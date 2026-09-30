import type { Argv } from "yargs"
import fs from "fs"
import os from "os"
import path from "path"
import { Database } from "@miao/core/database/database"
import { Global } from "@miao/core/global"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"

/**
 * Anomaly thresholds, in one place so they can be recalibrated from observed
 * data without hunting through the analysis code. Values are deliberately
 * conservative: a report that cries wolf gets ignored, which is worse than a
 * report that misses a slow leak.
 */
export const THRESHOLDS = {
  /** RSS growth above this, sustained with no recovery, is a leak. */
  rssSlopeBytesPerMinute: 10 * 1024 * 1024,
  /** Fraction of adjacent samples that must be non-decreasing to call it monotonic. */
  monotonicFraction: 0.8,
  /** Single-core CPU fraction above this, with the DB not growing, is a spin. */
  cpuBusyFraction: 0.8,
  /** fd/thread growth per hour that counts as a creep. */
  handleSlopePerHour: 1,
  /** Database file growth above this is unbounded event-log growth. */
  dbBytesPerHour: 200 * 1024 * 1024,
  /** Minimum samples before a trend is worth reporting at all. */
  minSamples: 5,
} as const

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`

interface Sample {
  type: "start" | "sample"
  t: number
  pid: number
  version?: string
  channel?: string
  intervalMs?: number
  db?: string
  uptime?: number
  rss?: number
  heapUsed?: number
  cpuUser?: number
  cpuSystem?: number
  fds?: number | null
  threads?: number | null
  swapUsed?: number | null
  loopMeanMs?: number | null
  loopP99Ms?: number | null
  load1?: number
  freeMem?: number
  totalMem?: number
  dbFileBytes?: number | null
  dbWalBytes?: number | null
}

/** A process killed mid-write leaves a partial final line; skip it, keep the rest. */
function parse(line: string): Sample | undefined {
  try {
    return JSON.parse(line) as Sample
  } catch {
    return undefined
  }
}

function duration(text: string | undefined, fallback: number) {
  if (!text) return fallback
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(text.trim())
  if (!match) return fallback
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"]
  return Number(match[1]) * scale
}

function files() {
  const dir = path.join(Global.Path.log, "monitor")
  if (!fs.existsSync(dir)) return [] as string[]
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dir, name))
}

/** Every sample in the window, grouped by the process that wrote it. */
function read(sinceMs: number) {
  const now = Date.now()
  const byPid = new Map<number, Sample[]>()
  let header: Sample | undefined
  for (const file of files()) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.length === 0) continue
      const sample = parse(line)
      if (!sample) continue
      if (now - sample.t > sinceMs) continue
      if (sample.type === "start") {
        header ??= sample
        continue
      }
      const list = byPid.get(sample.pid) ?? []
      list.push(sample)
      byPid.set(sample.pid, list)
    }
  }
  for (const list of byPid.values()) list.sort((a, b) => a.t - b.t)
  return { header, byPid }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function trend(samples: Sample[], pick: (sample: Sample) => number | null | undefined) {
  const points = samples
    .map((sample) => ({ x: sample.t, y: pick(sample) }))
    .filter((point): point is { x: number; y: number } => typeof point.y === "number")
  if (points.length < 2) return undefined
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  const rising = points.filter((point, index) => index > 0 && point.y >= points[index - 1]!.y).length
  return {
    count: points.length,
    first: points[0]!.y,
    last: points.at(-1)!.y,
    // Per minute, so the threshold reads the same over any window length.
    slopePerMinute: denominator === 0 ? 0 : (numerator / denominator) * 60_000,
    monotonic: rising / (points.length - 1),
  }
}

/** Cumulative CPU microseconds over the window, as a fraction of one core. */
function cpuFraction(samples: Sample[]) {
  const first = samples[0]!
  const last = samples.at(-1)!
  const wall = last.t - first.t
  if (wall <= 0) return 0
  const used = (last.cpuUser! + last.cpuSystem!) - (first.cpuUser! + first.cpuSystem!)
  return used / 1000 / wall
}

interface Finding {
  severity: "leak" | "spin" | "handle" | "growth" | "swap"
  pid?: number
  message: string
}

function analyze(samples: Sample[], pid: number): Finding[] {
  const findings: Finding[] = []

  const rss = trend(samples, (sample) => sample.rss)
  if (rss && rss.count >= THRESHOLDS.minSamples) {
    if (rss.slopePerMinute > THRESHOLDS.rssSlopeBytesPerMinute && rss.monotonic >= THRESHOLDS.monotonicFraction) {
      findings.push({
        severity: "leak",
        pid,
        message:
          `RSS rising ${mb(rss.slopePerMinute)}/min (${mb(rss.first)} → ${mb(rss.last)}), ` +
          `${pct(rss.monotonic)} of samples non-decreasing — looks like a leak`,
      })
    }
  }

  const db = trend(samples, (sample) => sample.dbFileBytes)
  const cpu = cpuFraction(samples)
  if (samples.length >= THRESHOLDS.minSamples && cpu > THRESHOLDS.cpuBusyFraction) {
    // High CPU while the database is not growing is work that produces nothing.
    const growing = (db?.slopePerMinute ?? 0) > 0
    findings.push({
      severity: "spin",
      pid,
      message:
        `${pct(cpu)} of one core over the window` +
        (growing ? " (database is growing, so this may be real work)" : " with no database growth — possible idle spin"),
    })
  }

  for (const [label, pick] of [
    ["fd", (sample: Sample) => sample.fds],
    ["thread", (sample: Sample) => sample.threads],
  ] as const) {
    const handle = trend(samples, pick)
    if (!handle || handle.count < THRESHOLDS.minSamples) continue
    const perHour = handle.slopePerMinute * 60
    if (perHour > THRESHOLDS.handleSlopePerHour && handle.monotonic >= THRESHOLDS.monotonicFraction) {
      findings.push({
        severity: "handle",
        pid,
        message: `${label} count rising ${perHour.toFixed(1)}/hour (${handle.first} → ${handle.last}) with no recovery`,
      })
    }
  }

  if (db) {
    const perHour = db.slopePerMinute * 60
    if (perHour > THRESHOLDS.dbBytesPerHour) {
      findings.push({
        severity: "growth",
        pid,
        message: `database growing ${mb(perHour)}/hour (${mb(db.first)} → ${mb(db.last)})`,
      })
    }
  }

  const swap = trend(samples, (sample) => sample.swapUsed)
  const free = trend(samples, (sample) => sample.freeMem)
  if (swap && free && swap.slopePerMinute > 0 && free.slopePerMinute < 0) {
    findings.push({
      severity: "swap",
      pid,
      message: `swap used rising (${mb(swap.first)} → ${mb(swap.last)}) while free memory falls — memory pressure`,
    })
  }

  return findings
}

const SnapshotCommand = effectCmd({
  command: "$0",
  describe: "report current process, system, and database health",
  instance: false,
  handler: Effect.fn("Cli.doctor")(function* () {
    const { header, byPid } = read(7 * 24 * 3_600_000)

    const live = [...byPid.entries()].filter(([pid]) => alive(pid))
    console.log("processes:")
    if (live.length === 0) {
      console.log("  (none sampled in the last 7 days)")
    }
    for (const [pid, samples] of live) {
      const last = samples.at(-1)!
      console.log(
        `  ${pid}\trss ${mb(last.rss ?? 0)}\theap ${mb(last.heapUsed ?? 0)}\tfds ${last.fds ?? "?"}\t` +
          `threads ${last.threads ?? "?"}\tup ${Math.round((last.uptime ?? 0) / 60)}m\t${samples.length} samples`,
      )
    }
    if (header?.version) console.log(`  sampled by miao ${header.version} (${header.channel})`)

    const [load1, load5, load15] = os.loadavg()
    console.log("\nsystem:")
    console.log(
      `  load:        ${load1?.toFixed(2)} ${load5?.toFixed(2)} ${load15?.toFixed(2)}   cpus: ${os.cpus().length}`,
    )
    console.log(
      `  memory:      ${mb(os.totalmem() - os.freemem())} used / ${mb(os.totalmem())} total` +
        `  (${pct(1 - os.freemem() / os.totalmem())})`,
    )

    const db = yield* Database.Service
    const pragma = (name: string) => db.db.get<Record<string, unknown>>(sql.raw(`PRAGMA ${name}`)).pipe(Effect.orDie)
    const pageSize = Number((yield* pragma("page_size"))?.page_size ?? 0)
    const pageCount = Number((yield* pragma("page_count"))?.page_count ?? 0)
    const freelist = Number((yield* pragma("freelist_count"))?.freelist_count ?? 0)

    console.log("\ndatabase:")
    console.log(`  path:        ${Database.path()}`)
    console.log(`  size:        ${mb(pageSize * pageCount)}   free: ${mb(pageSize * freelist)}`)

    const events = yield* db.db
      .all<{ type: string; n: number; bytes: number }>(
        sql`SELECT type, COUNT(*) AS n, SUM(LENGTH(data)) AS bytes FROM event GROUP BY type ORDER BY bytes DESC LIMIT 10`,
      )
      .pipe(Effect.orElseSucceed(() => [] as { type: string; n: number; bytes: number }[]))
    if (events.length > 0) {
      console.log("  event types:")
      for (const event of events) console.log(`    ${event.type}\t${event.n}\t${mb(event.bytes ?? 0)}`)
    }

    // Historical V1 rows are expected until the migration runs. What matters is
    // whether the count grows: `doctor report` tracks it across samples.
    const legacy = yield* db.db
      .get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM event WHERE type LIKE 'message.%'`)
      .pipe(Effect.orElseSucceed((): { n: number } | undefined => undefined))
    if (legacy && legacy.n > 0) {
      console.log(
        `\n  legacy V1 'message.*' rows: ${legacy.n}` +
          `  (run 'miao db compact' to reclaim; a rising count means V1 is writing again)`,
      )
    }

    const findings = live.flatMap(([pid, samples]) => analyze(samples, pid))
    console.log("\nfindings:")
    if (findings.length === 0) console.log("  none")
    for (const finding of findings) console.log(`  [${finding.severity}]\tpid ${finding.pid}\t${finding.message}`)
  }),
})

const ReportCommand = effectCmd({
  command: "report",
  describe: "replay sampled history and report trends and anomalies",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("since", { type: "string", default: "24h", describe: "window, e.g. 30m, 24h, 7d" })
      .option("json", { type: "boolean", default: false, describe: "emit machine-readable output" }),
  handler: Effect.fn("Cli.doctor.report")(function* (args: { since: string; json: boolean }) {
    const window = duration(args.since, 24 * 3_600_000)
    const { byPid } = read(window)
    const reports = [...byPid.entries()].map(([pid, samples]) => ({
      pid,
      samples: samples.length,
      alive: alive(pid),
      rss: trend(samples, (sample) => sample.rss),
      cpuFraction: samples.length >= 2 ? cpuFraction(samples) : undefined,
      fds: trend(samples, (sample) => sample.fds),
      threads: trend(samples, (sample) => sample.threads),
      db: trend(samples, (sample) => sample.dbFileBytes),
      swap: trend(samples, (sample) => sample.swapUsed),
      loopP99Ms: trend(samples, (sample) => sample.loopP99Ms),
      findings: analyze(samples, pid),
    }))

    if (args.json) {
      console.log(JSON.stringify({ since: args.since, windowMs: window, reports }, null, 2))
    } else if (reports.length === 0) {
      console.log(`no samples in the last ${args.since}.`)
      console.log(`the sampler writes to ${path.join(Global.Path.log, "monitor")} — check MIAO_MONITOR is not 0.`)
    } else {
      console.log(`window: last ${args.since}`)
      for (const report of reports) {
        console.log(`\npid ${report.pid}${report.alive ? "" : " (exited)"} — ${report.samples} samples`)
        const line = (label: string, value: string) => console.log(`  ${label.padEnd(12)}${value}`)
        if (report.rss) {
          line(
            "rss",
            `${mb(report.rss.first)} → ${mb(report.rss.last)}  (${mb(report.rss.slopePerMinute)}/min)`,
          )
        }
        if (report.cpuFraction !== undefined) line("cpu", `${pct(report.cpuFraction)} of one core`)
        if (report.fds) line("fds", `${report.fds.first} → ${report.fds.last}`)
        if (report.threads) line("threads", `${report.threads.first} → ${report.threads.last}`)
        if (report.db) line("database", `${mb(report.db.first)} → ${mb(report.db.last)}`)
        if (report.swap) line("swap used", `${mb(report.swap.first)} → ${mb(report.swap.last)}`)
        if (report.loopP99Ms) line("loop p99", `${report.loopP99Ms.last.toFixed(1)} ms`)
        for (const finding of report.findings) console.log(`  [${finding.severity}]  ${finding.message}`)
      }
    }

    const anomalies = reports.flatMap((report) => report.findings)
    if (anomalies.length > 0) {
      console.log(`\n${anomalies.length} finding(s).`)
      process.exitCode = 1
    }
  }),
})

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "process, storage, and system health",
  instance: false,
  builder: (yargs: Argv) => yargs.command(SnapshotCommand).command(ReportCommand).demandCommand(),
  handler: Effect.fn("Cli.doctor.root")(function* () {}),
})
