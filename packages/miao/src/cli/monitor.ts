// Continuous process/storage sampler for retrospective anomaly analysis.
//
// Every miao process samples itself so a leak, an idle-spin, or an fd/thread
// creep can be reconstructed after the fact (`miao doctor report`). A crash
// leaves the samples already on disk, which is the point — a monitor that only
// reports live state cannot explain a machine that got slow yesterday.
//
// Samples are process/OS metrics plus DB file sizes. They deliberately do NOT
// query the database: a COUNT(*) over the event table is exactly the kind of
// work that would perturb the thing being measured. `miao doctor` does the
// live queries on demand instead.
//
// On by default (30s x ~200B is negligible). Disable with MIAO_MONITOR=0.
import { execFile } from "node:child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { monitorEventLoopDelay } from "perf_hooks"
import { isMainThread, threadId } from "node:worker_threads"
import { DatabaseFile } from "@miao/core/database/file"
import { DiagnosticFiles } from "@miao/core/diagnostic-files"
import { Global } from "@miao/core/global"
import { InstallationChannel, InstallationVersion } from "@miao/core/installation/version"

const INTERVAL = 30_000
// Thread and swap probes shell out, so run them on every Nth tick only.
const HEAVY_EVERY = 10
const BUCKET = "monitor"
const budget = {
  match: (name: string) => /^(cli|tui|serve)-\d+\.jsonl(?:\.previous)?$/.test(name),
  maxBytes: 32 * DiagnosticFiles.MiB,
  maxFiles: 64,
}

let timer: Timer | undefined
let ticks = 0
let target: string | undefined
let loop: ReturnType<typeof monitorEventLoopDelay> | undefined
let pending: Promise<void> | undefined
let writes = Promise.resolve()
let skipped = 0
let windowStarted = performance.now()

/** Detached timer so the sampler never keeps a short-lived CLI invocation alive. */
export function start(options: { intervalMs?: number } = {}) {
  if (timer) return
  writes = writes.then(async () => {
    await DiagnosticFiles.cleanupAsync(path.join(Global.Path.log, BUCKET), budget)
    await DiagnosticFiles.cleanupAsync(Global.Path.log, {
      match: (name) => name === "tui.log" || name === "tui.log.previous",
      maxBytes: 2 * DiagnosticFiles.MiB,
      maxFiles: 2,
    })
  })
  if (process.env["MIAO_MONITOR"] === "0") return

  loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  windowStarted = performance.now()

  const interval = options.intervalMs ?? INTERVAL
  append(header(interval))
  ticks = 0
  timer = setInterval(() => {
    if (pending) {
      skipped += 1
      return
    }
    ticks += 1
    pending = sample()
      .then(append)
      .catch(() => {})
      .finally(() => {
        pending = undefined
      })
  }, interval)
  timer.unref?.()
}

function file() {
  if (!target) {
    const kind = process.env["MIAO_SERVE"] ? "serve" : process.argv[1]?.includes("tui") ? "tui" : "cli"
    target = path.join(Global.Path.log, BUCKET, `${kind}-${process.pid}.jsonl`)
  }
  return target
}

function append(line: unknown) {
  const text = JSON.stringify(line) + "\n"
  writes = writes
    .then(() => DiagnosticFiles.appendAsync(file(), text, DiagnosticFiles.MiB, budget))
    .then(
      () => undefined,
      () => undefined,
    )
  return writes
}

function header(interval: number) {
  return {
    type: "start",
    t: Date.now(),
    pid: process.pid,
    isolate: isMainThread ? "main" : "worker",
    threadId,
    loopStats: "window",
    loopResolutionMs: 20,
    version: InstallationVersion,
    channel: InstallationChannel,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    intervalMs: interval,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    db: DatabaseFile.path(),
  }
}

async function sample() {
  const started = performance.now()
  const timestamp = Date.now()
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  // Ticks start at 1, so `=== 1` puts thread/swap in the very first sample
  // rather than making the report wait out a full heavy interval.
  const heavy = ticks === 1 || ticks % HEAVY_EVERY === 0
  const db = DatabaseFile.path()
  const count = loop?.count ?? 0
  const ms = (nanos: number | undefined) =>
    count > 0 && nanos !== undefined && Number.isFinite(nanos) ? Math.round(nanos / 1e5) / 10 : null
  const latency = {
    loopWindowMs: Math.round(started - windowStarted),
    loopCount: count,
    loopMeanMs: ms(loop?.mean),
    loopP95Ms: ms(loop?.percentile(95)),
    loopP99Ms: ms(loop?.percentile(99)),
    loopMaxMs: ms(loop?.max),
  }
  loop?.reset()
  windowStarted = started
  const [threads, swap, fds, dbFileBytes, dbWalBytes] = await Promise.all([
    heavy ? threadCount().catch(() => null) : null,
    heavy ? swapUsed().catch(() => null) : null,
    fs.promises.readdir(fdDir()).then(
      (files) => files.length,
      () => null,
    ),
    fs.promises.stat(db).then(
      (stat) => stat.size,
      () => null,
    ),
    fs.promises.stat(`${db}-wal`).then(
      (stat) => stat.size,
      () => null,
    ),
  ])

  return {
    type: "sample",
    t: timestamp,
    pid: process.pid,
    isolate: isMainThread ? "main" : "worker",
    threadId,
    uptime: Math.round(process.uptime()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    // Cumulative counters. Rates are derived by the report, never by the
    // sampler: an instantaneous `%CPU` is a lifetime average in disguise.
    cpuUser: cpu.user,
    cpuSystem: cpu.system,
    fds,
    threads,
    swapUsed: swap,
    ...latency,
    probeMs: Math.round(performance.now() - started),
    skippedSamples: skipped,
    load1: os.loadavg()[0],
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    dbFileBytes,
    dbWalBytes,
  }
}

export async function stop() {
  if (timer) clearInterval(timer)
  timer = undefined
  loop?.disable()
  await pending
  await writes
  loop = undefined
}

const fdDir = () => (process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd")

function command(name: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(name, args, { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout)
    })
  })
}

async function threadCount() {
  if (process.platform === "darwin") {
    const out = await command("ps", ["-M", String(process.pid)])
    // One header line, then one line per thread.
    return Math.max(0, out.trimEnd().split("\n").length - 1)
  }
  const status = await fs.promises.readFile("/proc/self/status", "utf8")
  const match = /^Threads:\s*(\d+)/m.exec(status)
  if (!match) throw new Error("no Threads line in /proc/self/status")
  return Number(match[1])
}

async function swapUsed() {
  if (process.platform === "darwin") {
    const out = await command("sysctl", ["-n", "vm.swapusage"])
    const match = /used\s*=\s*([\d.]+)M/.exec(out)
    if (!match) throw new Error("unrecognized vm.swapusage output")
    return Math.round(Number(match[1]) * 1024 * 1024)
  }
  const info = await fs.promises.readFile("/proc/meminfo", "utf8")
  const total = Number(/^SwapTotal:\s*(\d+) kB/m.exec(info)?.[1] ?? 0)
  const free = Number(/^SwapFree:\s*(\d+) kB/m.exec(info)?.[1] ?? 0)
  return (total - free) * 1024
}

export * as Monitor from "./monitor"
