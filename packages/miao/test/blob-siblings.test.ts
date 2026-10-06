import { describe, expect, it } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Effect, Exit } from "effect"
import { BlobSiblings } from "@/cli/blob-siblings"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function makeDatabase(file: string, setup: (native: NativeDatabase) => void) {
  const native = new NativeDatabase(file)
  try {
    setup(native)
  } finally {
    native.close()
  }
}

describe("BlobSiblings", () => {
  it("collects blob references from a sibling database", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blob-siblings-"))
    const file = path.join(dir, "miao-local.db")
    makeDatabase(file, (native) => {
      native.run("CREATE TABLE session_message (data TEXT)")
      native.run("CREATE TABLE event (data TEXT)")
      native.run("CREATE TABLE session_input (prompt TEXT)")
      native.run(`INSERT INTO event (data) VALUES ('{"ref":"blob://${HASH_B}"}')`)
      native.run(`INSERT INTO session_message (data) VALUES ('{"text":"no blobs here"}')`)
    })
    const references = await Effect.runPromise(BlobSiblings.collectReferences(file))
    expect([...references]).toEqual([HASH_B])
  })

  it("skips source tables an older sibling does not have", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blob-siblings-"))
    const file = path.join(dir, "miao.db")
    makeDatabase(file, (native) => {
      native.run("CREATE TABLE event (data TEXT)")
      native.run(`INSERT INTO event (data) VALUES ('{"ref":"blob://${HASH_A}"}')`)
    })
    const references = await Effect.runPromise(BlobSiblings.collectReferences(file))
    expect([...references]).toEqual([HASH_A])
  })

  it("fails when the sibling database cannot be read", async () => {
    const exit = await Effect.runPromiseExit(
      BlobSiblings.collectReferences(path.join(os.tmpdir(), "blob-siblings-missing.db")),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
