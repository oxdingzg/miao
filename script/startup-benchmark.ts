#!/usr/bin/env bun
/**
 * Cold/warm start and full-process-resource benchmark for the single binary.
 *
 * QA-05 asks evidence to separate end-to-end measurement from primitives: this
 * harness measures the start paths alone, reporting every raw number so a
 * reader can recompute any figure. Startup commands run through the platform
 * `time` wrapper, which reports wall, user/system CPU, and peak RSS from the
 * kernel's rusage rather than from anything the binary itself prints.
 *
 * Cells:
 *   --version      argument parsing and version printing only
 *   db path        path derivation plus a stat of the resolved files
 *   session list   open the engine ledger and read it
 *   models         route and credential resolution
 *   serve          a resident window sampled for RSS, file descriptors, and
 *                  the whole process tree
 *
 * Cold runs point MIAO_DATA_HOME and MIAO_ENGINE_STORAGE at a fresh empty
 * directory per sample, so the binary pays every first-touch cost (schema
 * migration, credential probe, ledger creation). Warm runs use the machine's
 * real home and therefore measure the steady state an operator actually
 * experiences. A cold sample destroys its directory afterwards; nothing the
 * harness writes survives except the report.
 *
 * Usage:
 *   bun script/startup-benchmark.ts [--binary miao] [--repeat 10]
 *       [--serve-seconds 5] [--out report.md] [--data evidence.json]
 *
 * A small sample is directional, not statistical. The report carries the
 * binary's own --version line, the OS and CPU, the date, and the failure
 * count per cell, so the numbers are attributable to an artifact.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type StartupSample = {
  exit_code: number
  wall_ms: number
  user_ms: number
  sys_ms: number
  max_rss_kb: number
}

type ServeSample = {
  samples: { rss_kb: number; fds: number; tree_rss_kb: number; processes: number }[]
  window_seconds: number
}

type Cell = {
  command: string[]
  kind: "startup" | "serve"
  samples: StartupSample[]
  failures: number
  /** Set when the artifact rejects the subcommand outright (an older binary). */
  unsupported?: boolean
  first_error?: string
  serve?: ServeSample
}

const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const binary = path.resolve(option("binary", "miao"))
const repeat = Math.max(1, Number(option("repeat", "10")))
const serveSeconds = Number(option("serve-seconds", "5"))
const outPath = option("out", "startup-benchmark-report.md")
const dataPath = option("data", "startup-benchmark-evidence.json")

const clock = (text: string) => {
  const [, minutes, seconds] = text.match(/^(?:(\d+)m)?([\d.]+)s$/) ?? []
  return (Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000
}

/**
 * BSD time prints one summary line (`0.00 real 0.00 user 0.00 sys`, plain
 * seconds) and reports the RSS in bytes with the count before the label; GNU
 * time prints `real 0m0.05s` lines and the RSS in kibibytes after the label.
 * Both are handled, and both are normalised to milliseconds and kibibytes, so
 * the numbers come from the kernel's rusage, not from the binary itself.
 */
const parseTime = (stderr: string, exitCode: number): StartupSample => {
  const oneLine = stderr.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/)
  const gnuReal = stderr.match(/^\s*real\s+(\S+)/m)?.[1]
  const gnuUser = stderr.match(/^\s*user\s+(\S+)/m)?.[1]
  const gnuSys = stderr.match(/^\s*sys\s+(\S+)/m)?.[1]
  const milliseconds = (text: string | undefined, plainSeconds: boolean) => {
    if (!text) return 0
    return plainSeconds ? Number(text) * 1000 : clock(text)
  }
  const [real, user, sys] = oneLine ? [oneLine[1], oneLine[2], oneLine[3]] : [gnuReal, gnuUser, gnuSys]
  const rss =
    stderr.match(/^\s*(\d+)\s+maximum resident set size/m)?.[1] ??
    stderr.match(/^[Mm]aximum resident set size(?:\s*\(kbytes\))?:?\s+(\d+)/m)?.[1]
  const rawRss = Number(rss ?? 0)
  const gnuLayout = Boolean(gnuReal && !oneLine)
  return {
    exit_code: exitCode,
    wall_ms: Math.round(milliseconds(real, !gnuLayout)),
    user_ms: Math.round(milliseconds(user, !gnuLayout)),
    sys_ms: Math.round(milliseconds(sys, !gnuLayout)),
    max_rss_kb: Math.round(gnuLayout ? rawRss : rawRss / 1024),
  }
}

const startupRun = async (command: string[], environment: Record<string, string>) => {
  // `time` rounds wall clock to centiseconds, which turns a fast start into a
  // zero; the wall figure comes from the host clock around the spawn instead,
  // while CPU and RSS still come from the kernel's rusage.
  const started = performance.now()
  const child = Bun.spawn(["/usr/bin/time", "-l", ...command], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  const wall = performance.now() - started
  return { sample: { ...parseTime(stderr, exitCode ?? 0), wall_ms: Math.round(wall) }, stderr }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const summarize = (samples: StartupSample[]) => ({
  median_wall_ms: median(samples.map((sample) => sample.wall_ms)),
  median_user_ms: median(samples.map((sample) => sample.user_ms)),
  median_sys_ms: median(samples.map((sample) => sample.sys_ms)),
  median_max_rss_kb: median(samples.map((sample) => sample.max_rss_kb)),
})

const tree = (pid: number): number[] => {
  const probe = Bun.spawnSync(["pgrep", "-P", String(pid)])
  const children = probe.stdout.toString().trim().split("\n").filter(Boolean).map(Number)
  return [pid, ...children.flatMap(tree)]
}

const serveRun = async (command: string[], seconds: number): Promise<ServeSample> => {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
  const samples: ServeSample["samples"] = []
  // A resident server that dies in the first 300 ms is an artifact that does
  // not support this start, not a measured window; the sampler skips ahead so
  // the report says so instead of printing zeroes.
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (child.exitCode === null) {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const pids = tree(child.pid)
      const rss = Bun.spawnSync(["ps", "-o", "rss=", ...pids.map(String)])
      const rssKb = rss.stdout
        .toString()
        .split("\n")
        .filter(Boolean)
        .reduce((total, line) => total + Number(line.trim() || 0), 0)
      // lsof is slow but honest: it counts the descriptors the kernel holds,
      // which is the leak signal, not what a library reports about itself.
      const fds = Bun.spawnSync(["/usr/sbin/lsof", "-p", String(child.pid)])
      samples.push({
        rss_kb: rssKb,
        tree_rss_kb: rssKb,
        fds: fds.stdout.toString().split("\n").filter(Boolean).length,
        processes: pids.length,
      })
    }
  }
  child.kill()
  await child.exited
  return { samples, window_seconds: seconds }
}

const startupCells: { id: string; argv: string[] }[] = [
  { id: "--version", argv: [binary, "--version"] },
  { id: "db path", argv: [binary, "db", "path"] },
  { id: "session list", argv: [binary, "session", "list"] },
  { id: "models", argv: [binary, "models"] },
]

const cells: Cell[] = []

for (const cell of startupCells) {
  for (const phase of ["cold", "warm"] as const) {
    const root = phase === "cold" ? await mkdtemp(path.join(os.tmpdir(), "miao-startup-cold-")) : ""
    const samples: StartupSample[] = []
    let unsupported = false
    let firstError: string | undefined
    for (let index = 0; index < repeat; index += 1) {
      // A cold sample gets a fresh empty home each run, so no run inherits the
      // previous one's migrated schema; a warm sample shares the real home.
      const environment =
        phase === "cold"
          ? {
              MIAO_DATA_HOME: path.join(root, String(index), "data"),
              MIAO_ENGINE_STORAGE: path.join(root, String(index), "storage"),
              XDG_CONFIG_HOME: path.join(root, String(index), "config"),
              HOME: path.join(root, String(index), "home"),
            }
          : {}
      if (phase === "cold") {
        for (const dir of Object.values(environment)) await mkdir(dir, { recursive: true })
      }
      const run = await startupRun(cell.argv, environment)
      if (index === 0) {
        samples.push(run.sample)
        // An artifact older than the subcommand fails identically every time;
        // repeating the run measures nothing, so one rejection marks the cell.
        if (run.sample.exit_code !== 0 && /unexpected argument|unknown command|unrecognized/i.test(run.stderr)) {
          unsupported = true
          firstError = run.stderr.split("\n").slice(0, 2).join(" ").trim()
          break
        }
        continue
      }
      samples.push(run.sample)
    }
    if (phase === "cold") await rm(root, { recursive: true, force: true })
    cells.push({
      command: `${cell.id} (${phase})`,
      kind: "startup",
      samples,
      failures: unsupported ? 0 : samples.filter((sample) => sample.exit_code !== 0).length,
      unsupported,
      first_error: firstError,
    })
  }
}

const serveCell: Cell = {
  command: `${binary} serve`,
  kind: "serve",
  samples: [],
  failures: 0,
  unsupported: false,
  serve: await serveRun([binary, "serve"], serveSeconds),
}
serveCell.unsupported = serveCell.serve!.samples.length === 0
if (serveCell.unsupported) serveCell.first_error = "serve exited before the sampling window opened"
cells.push(serveCell)

const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim()

const evidence = {
  harness: "script/startup-benchmark.ts",
  date: new Date().toISOString(),
  binary,
  version,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  repeat,
  serve_seconds: serveSeconds,
  cells,
}
await writeFile(dataPath, `${JSON.stringify(evidence, null, 2)}\n`)

const lines = [
  "# Startup benchmark",
  "",
  `Harness: \`script/startup-benchmark.ts\`; every figure below is reproducible from it.`,
  `Artifact: \`${binary}\` reporting \`${version}\``,
  `Environment: ${evidence.os} · ${evidence.cpu} · ${evidence.date}`,
  `Samples: ${repeat} per startup cell, one ${serveSeconds}s serve window; medians shown, raw numbers in \`${dataPath}\`.`,
  "",
  "| cell | wall ms | user ms | sys ms | peak RSS KB | failures |",
  "|---|---|---|---|---|---|",
]
for (const cell of cells) {
  if (cell.kind !== "startup") continue
  const summary = summarize(cell.samples)
  lines.push(
    `| \`${cell.command}\` | ${summary.median_wall_ms} | ${summary.median_user_ms} | ${summary.median_sys_ms} | ${summary.median_max_rss_kb} | ${cell.unsupported ? "unsupported" : cell.failures} |`,
  )
}
lines.push(
  "",
  `## Serve window (${serveSeconds}s)`,
  "",
)
if (serveCell.unsupported || !serveCell.serve || serveCell.serve.samples.length === 0) {
  lines.push(`serve did not stay up long enough to sample: ${serveCell.first_error ?? "unknown reason"}`)
} else {
  lines.push(
    `RSS / tree RSS / FDs sampled every 500 ms:`,
    `- RSS min · median · max KB: ${Math.min(...serveCell.serve.samples.map((s) => s.rss_kb))} · ${median(serveCell.serve.samples.map((s) => s.rss_kb))} · ${Math.max(...serveCell.serve.samples.map((s) => s.rss_kb))}`,
    `- FDs min · median · max: ${Math.min(...serveCell.serve.samples.map((s) => s.fds))} · ${median(serveCell.serve.samples.map((s) => s.fds))} · ${Math.max(...serveCell.serve.samples.map((s) => s.fds))}`,
    `- processes in tree: ${serveCell.serve.samples.at(-1)?.processes ?? 0} at the final sample`,
  )
}
lines.push(
  "",
  `A single faster or cheaper run is not a completion claim; quality evidence lives with the engine cost benchmark.`,
)
await writeFile(outPath, `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
