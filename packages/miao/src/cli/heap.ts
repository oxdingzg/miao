import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { DiagnosticFiles } from "@miao/core/diagnostic-files"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

let timer: Timer | undefined
let lock = false
let armed = true

export function start() {
  if (!Flag.MIAO_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch(() => {})
    // Snapshots are diagnostic artifacts: bounded like the rest of the log
    // directory instead of growing without limit across months of RSS spikes.
    await DiagnosticFiles.cleanupAsync(Global.Path.log, {
      match: (name) => /^heap-.*\.heapsnapshot$/.test(name),
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxFiles: 4,
    })

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
