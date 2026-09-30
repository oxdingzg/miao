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
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { monitorEventLoopDelay } from "perf_hooks"
import { Database } from "@miao/core/database/database"
import { Global } from "@miao/core/global"
import { InstallationChannel, InstallationVersion } from "@miao/core/installation/version"

const INTERVAL = 30_000
// Thread and swap probes shell out, so run them on every Nth tick only.
const HEAVY_EVERY = 10
const BUCKET = "monitor"

let timer: Timer | undefined
let ticks = 0
let target: string | undefined
let loop: ReturnType<typeof monitorEventLoopDelay> | undefined

/** Detached timer so the sampler never keeps a short-lived CLI invocation alive. */
export function start() {
  if (timer) return
  if (process.env["MIAO_MONITOR"] === "0") return

  loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()

  append(header())
  ticks = 0
  timer = setInterval(() => {
    ticks += 1
    append(sample())
  }, INTERVAL)
  timer.unref?.()
}

/**
 * Best-effort probe: a metric that cannot be read is recorded as null rather
 * than aborting the sample. A sampler that stops on the first permission error
 * is worse than no sampler, because the gap looks like the process died.
 */
function probe<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

function file() {
  if (!target) {
    const kind = process.env["MIAO_SERVE"] ? "serve" : process.argv[1]?.includes("tui") ? "tui" : "cli"
    target = path.join(Global.Path.log, BUCKET, `${kind}-${process.pid}.jsonl`)
  }
  return target
}

function append(line: unknown) {
  probe(() => {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.appendFileSync(file(), JSON.stringify(line) + "\n")
  })
}

function header() {
  return {
    type: "start",
    t: Date.now(),
    pid: process.pid,
    version: InstallationVersion,
    channel: InstallationChannel,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    intervalMs: INTERVAL,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    db: Database.path(),
  }
}

function sample() {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  // Ticks start at 1, so `=== 1` puts thread/swap in the very first sample
  // rather than making the report wait out a full heavy interval.
  const heavy = ticks === 1 || ticks % HEAVY_EVERY === 0
  const db = Database.path()
  const ms = (nanos: number) => Math.round(nanos / 1e5) / 10

  return {
    type: "sample",
    t: Date.now(),
    pid: process.pid,
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
    fds: probe(() => fs.readdirSync(fdDir()).length),
    threads: heavy ? probe(threadCount) : null,
    swapUsed: heavy ? probe(swapUsed) : null,
    loopMeanMs: loop ? ms(loop.mean) : null,
    loopP99Ms: loop ? ms(loop.percentile(99)) : null,
    load1: os.loadavg()[0],
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    dbFileBytes: probe(() => fs.statSync(db).size),
    dbWalBytes: probe(() => fs.statSync(`${db}-wal`).size),
  }
}

const fdDir = () => (process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd")

function threadCount() {
  if (process.platform === "darwin") {
    const out = execFileSync("ps", ["-M", String(process.pid)], { encoding: "utf8", timeout: 5_000 })
    // One header line, then one line per thread.
    return Math.max(0, out.trimEnd().split("\n").length - 1)
  }
  const status = fs.readFileSync("/proc/self/status", "utf8")
  const match = /^Threads:\s*(\d+)/m.exec(status)
  if (!match) throw new Error("no Threads line in /proc/self/status")
  return Number(match[1])
}

function swapUsed() {
  if (process.platform === "darwin") {
    const out = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8", timeout: 5_000 })
    const match = /used\s*=\s*([\d.]+)M/.exec(out)
    if (!match) throw new Error("unrecognized vm.swapusage output")
    return Math.round(Number(match[1]) * 1024 * 1024)
  }
  const info = fs.readFileSync("/proc/meminfo", "utf8")
  const total = Number(/^SwapTotal:\s*(\d+) kB/m.exec(info)?.[1] ?? 0)
  const free = Number(/^SwapFree:\s*(\d+) kB/m.exec(info)?.[1] ?? 0)
  return (total - free) * 1024
}

export * as Monitor from "./monitor"
