import { describe, expect, it } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Maintenance } from "@/cli/maintenance"

const HASH_LIVE = "1".repeat(64)
const HASH_SIBLING = "2".repeat(64)
const HASH_ORPHAN = "3".repeat(64)
const HASH_FRESH = "4".repeat(64)

async function makeDatabase(file: string, blobHash: string) {
  const native = new NativeDatabase(file)
  try {
    native.run("PRAGMA journal_mode=WAL")
    native.run("CREATE TABLE session_message (data TEXT)")
    native.run("CREATE TABLE event (data TEXT)")
    native.run("CREATE TABLE session_input (prompt TEXT)")
    native.run(`INSERT INTO event (data) VALUES ('{"ref":"blob://${blobHash}"}')`)
  } finally {
    native.close()
  }
}

describe("Maintenance.runOnce", () => {
  it("sweeps only blobs no channel references and checkpoints", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-"))
    await makeDatabase(path.join(dir, "miao.db"), HASH_LIVE)
    await makeDatabase(path.join(dir, "miao-local.db"), HASH_SIBLING)
    const blobDirectory = path.join(dir, "blobs")
    await fs.mkdir(blobDirectory)
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    for (const [hash, mtime] of [
      [HASH_LIVE, new Date()],
      [HASH_SIBLING, weekAgo],
      [HASH_ORPHAN, weekAgo],
      [HASH_FRESH, new Date()],
    ] as const) {
      const file = path.join(blobDirectory, hash)
      await fs.writeFile(file, hash.slice(0, 8))
      await fs.utimes(file, mtime, mtime)
    }

    const summary = await Maintenance.runOnce(dir)

    expect(summary.databases).toBe(2)
    expect(summary.orphans).toBe(1)
    expect(summary.deleted).toBe(1)
    expect(summary.checkpointed).toBe(true)
    // The fresh orphan survives the seven-day grace window by design.
    expect(await fs.readdir(blobDirectory).then((names) => names.sort())).toEqual(
      [HASH_LIVE, HASH_SIBLING, HASH_FRESH].sort(),
    )
  })

  it("refuses to sweep when a channel database cannot be read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-"))
    await fs.writeFile(path.join(dir, "miao-broken.db"), "not a database")
    const blobDirectory = path.join(dir, "blobs")
    await fs.mkdir(blobDirectory)
    const orphan = path.join(blobDirectory, HASH_ORPHAN)
    await fs.writeFile(orphan, "orphan")

    const summary = await Maintenance.runOnce(dir)

    expect(summary.deleted).toBe(0)
    expect(await fs.readdir(blobDirectory)).toEqual([HASH_ORPHAN])
  })
})
