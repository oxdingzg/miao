import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

test.skipIf(process.platform !== "darwin")(
  "slow process probes do not block the monitor isolate or overlap samples",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-monitor-async-"))
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await Bun.write(path.join(bin, "ps"), "#!/bin/sh\n/bin/sleep 0.5\nprintf 'header\\nthread\\n'\n")
    await Bun.write(path.join(bin, "sysctl"), "#!/bin/sh\n/bin/sleep 0.5\nprintf 'used = 1.0M'\n")
    await fs.chmod(path.join(bin, "ps"), 0o755)
    await fs.chmod(path.join(bin, "sysctl"), 0o755)
    const script = path.join(root, "capture.ts")
    await Bun.write(
      script,
      `
import { Monitor } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/monitor.ts", import.meta.url)))}
import fs from "node:fs"
const directory = ${JSON.stringify(path.join(root, "data", "miao", "log", "monitor"))}
await fs.promises.mkdir(directory, { recursive: true })
const complete = Promise.withResolvers<void>()
const watch = fs.watch(directory, (_, name) => {
  if (!String(name).endsWith(".jsonl")) return
  void Bun.file(directory + "/" + name).text().then((text) => {
    const records = text.trim().split("\\n").map((line) => JSON.parse(line))
    if (records.filter((record) => record.type === "sample").length >= 2) complete.resolve()
  }).catch(() => {})
})
const heartbeats = { count: 0 }
const beat = setInterval(() => { heartbeats.count += 1 }, 10)
Monitor.start({ intervalMs: 100 })
await complete.promise
watch.close()
await Monitor.stop()
clearInterval(beat)
console.log(JSON.stringify(heartbeats))
`,
    )
    const child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        MIAO_MONITOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const output = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(0)
      expect(stderr).toBe("")
      const heartbeats = JSON.parse(output)
      // This is a responsiveness check during deliberately slow I/O, not a
      // machine-dependent input-latency threshold.
      expect(heartbeats.count).toBeGreaterThan(20)
      const dir = path.join(root, "data", "miao", "log", "monitor")
      const files = await fs.readdir(dir)
      const records = (await Bun.file(path.join(dir, files.find((file) => file.endsWith(".jsonl"))!)).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records[0]).toMatchObject({ type: "start", isolate: "main", loopStats: "window", intervalMs: 100 })
      const samples = records.filter((record) => record.type === "sample")
      expect(samples.length).toBeGreaterThanOrEqual(2)
      expect(samples[0]).toMatchObject({ threads: 1, swapUsed: 1024 * 1024 })
      expect(samples[0].probeMs).toBeGreaterThan(400)
      expect(samples.at(-1).skippedSamples).toBeGreaterThan(0)
      for (const sample of samples) {
        expect(sample.loopCount).toBeGreaterThan(0)
        expect(sample.loopWindowMs).toBeGreaterThan(0)
        expect(sample.loopP95Ms).toBeLessThanOrEqual(sample.loopP99Ms)
        // Native histograms round percentile buckets; max is the actual sample.
        expect(sample.loopP99Ms).toBeLessThanOrEqual(sample.loopMaxMs + 1)
      }
    } finally {
      child.kill()
      await child.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  10_000,
)
