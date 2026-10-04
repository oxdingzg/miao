import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DiagnosticFiles } from "../src/diagnostic-files"

function fixture(run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miao-diagnostic-budget-"))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const budget = {
  match: (name: string) => name.endsWith(".log") || name.endsWith(".previous"),
  maxBytes: 16,
  maxFiles: 2,
}

async function fixtureAsync(run: (dir: string) => Promise<void>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "miao-diagnostic-async-"))
  try {
    await run(dir)
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

describe("bounded diagnostic storage", () => {
  test("asynchronous writes rotate with the same byte and file limits", () =>
    fixtureAsync(async (dir) => {
      const file = path.join(dir, "miao.log")
      await fs.promises.writeFile(path.join(dir, "unrelated.db"), "keep")
      expect(await DiagnosticFiles.appendAsync(file, "12345678", 8, budget)).toBe(true)
      expect(await DiagnosticFiles.appendAsync(file, "abcdefgh", 8, budget)).toBe(true)
      expect(await DiagnosticFiles.appendAsync(file, "latest", 8, budget)).toBe(true)
      expect(await fs.promises.readFile(`${file}.previous`, "utf8")).toBe("abcdefgh")
      expect(await fs.promises.readFile(file, "utf8")).toBe("latest")
      expect(await fs.promises.readFile(path.join(dir, "unrelated.db"), "utf8")).toBe("keep")
      expect(await DiagnosticFiles.appendAsync(file, "x".repeat(9), 8, budget)).toBe(false)
    }))

  test("asynchronous writers respect a synchronous writer's live lease", () =>
    fixtureAsync(async (dir) => {
      const release = DiagnosticFiles.lease(dir)
      try {
        expect(await DiagnosticFiles.appendAsync(path.join(dir, "miao.log"), "new", 8, budget)).toBe(false)
      } finally {
        release?.()
      }
      expect(await DiagnosticFiles.appendAsync(path.join(dir, "miao.log"), "new", 8, budget)).toBe(true)
    }))

  test("asynchronous cleanup enforces retention without deleting unrelated files", () =>
    fixtureAsync(async (dir) => {
      await fs.promises.writeFile(path.join(dir, "old.log"), "x".repeat(100))
      await fs.promises.writeFile(path.join(dir, "unrelated.db"), "keep")
      await DiagnosticFiles.cleanupAsync(dir, budget)
      expect(await fs.promises.readdir(dir)).toEqual(["unrelated.db"])
    }))
  test("rotates before exceeding the file limit and retains only one backup", () =>
    fixture((dir) => {
      const file = path.join(dir, "miao.log")
      expect(DiagnosticFiles.append(file, "12345678", 8, budget)).toBe(true)
      expect(DiagnosticFiles.append(file, "abcdefgh", 8, budget)).toBe(true)
      expect(fs.readFileSync(`${file}.previous`, "utf8")).toBe("12345678")
      expect(DiagnosticFiles.append(file, "latest", 8, budget)).toBe(true)
      expect(fs.readFileSync(`${file}.previous`, "utf8")).toBe("abcdefgh")
      expect(fs.readFileSync(file, "utf8")).toBe("latest")
      expect(fs.readdirSync(dir).sort()).toEqual(["miao.log", "miao.log.previous"])
    }))

  test("enforces a directory byte budget and leaves unrelated files alone", () =>
    fixture((dir) => {
      fs.writeFileSync(path.join(dir, "unrelated.db"), "keep")
      fs.writeFileSync(path.join(dir, "old.log"), "x".repeat(100))
      const file = path.join(dir, "miao.log")
      expect(DiagnosticFiles.append(file, "new", 8, budget)).toBe(true)
      expect(fs.existsSync(path.join(dir, "old.log"))).toBe(false)
      expect(fs.readFileSync(path.join(dir, "unrelated.db"), "utf8")).toBe("keep")
      expect(DiagnosticFiles.append(file, "x".repeat(9), 8, budget)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("new")
    }))

  test("does not steal a live writer's lease", () =>
    fixture((dir) => {
      const release = DiagnosticFiles.lease(dir)
      expect(release).toBeDefined()
      try {
        expect(DiagnosticFiles.append(path.join(dir, "miao.log"), "new", 8, budget)).toBe(false)
      } finally {
        release?.()
      }
      expect(DiagnosticFiles.append(path.join(dir, "miao.log"), "new", 8, budget)).toBe(true)
    }))

  test("recovers an abandoned incomplete lease after a minute", () =>
    fixture((dir) => {
      const lock = path.join(dir, ".diagnostic-write-lock")
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, "pid"), "")
      const old = new Date(Date.now() - 65_000)
      fs.utimesSync(lock, old, old)
      expect(DiagnosticFiles.append(path.join(dir, "miao.log"), "new", 8, budget)).toBe(true)
      expect(fs.existsSync(lock)).toBe(false)
    }))

  test("reserves space before a streamed artifact is created", () =>
    fixture((dir) => {
      fs.writeFileSync(path.join(dir, "old.log"), "x".repeat(12))
      const release = DiagnosticFiles.lease(dir)
      try {
        expect(DiagnosticFiles.prune(dir, budget, 8, path.join(dir, "new.log"))).toBe(true)
        expect(fs.existsSync(path.join(dir, "old.log"))).toBe(false)
      } finally {
        release?.()
      }
    }))
})
