import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { addChineseLink, chineseLink } from "./release-notes"

test("adds the 简体中文 link under the first heading", () => {
  const notes = "## [0.1.4] - 2026-10-04\n\n### Fixed\n- a fix (`abc123`)\n"
  const out = addChineseLink(notes, "v0.1.4")
  expect(out).toBe(
    "## [0.1.4] - 2026-10-04\n\n" +
      "[简体中文](https://github.com/oxdingzg/miao/blob/main/docs/releases/v0.1.4.zh.md)\n\n" +
      "### Fixed\n- a fix (`abc123`)\n",
  )
})

test("uses the given repository", () => {
  expect(chineseLink("v9.9.9", "owner/repo")).toBe(
    "[简体中文](https://github.com/owner/repo/blob/main/docs/releases/v9.9.9.zh.md)",
  )
})

test("falls back to prepending when there is no heading", () => {
  const out = addChineseLink("No notable changes", "v1.0.0")
  expect(out.startsWith("[简体中文](https://github.com/oxdingzg/miao/blob/main/docs/releases/v1.0.0.zh.md)\n\n")).toBe(true)
  expect(out.endsWith("No notable changes")).toBe(true)
})



function publishFixture(english: boolean, chinese: boolean) {
  const cwd = mkdtempSync(path.join(tmpdir(), "miao-release-notes-"))
  const docs = path.join(cwd, "docs/releases")
  mkdirSync(docs, { recursive: true })
  if (english) writeFileSync(path.join(docs, "v1.2.3.md"), "## Version 1.2.3\n\n### Upgrading\nRestart existing windows.\n")
  if (chinese) writeFileSync(path.join(docs, "v1.2.3.zh.md"), "## 版本 1.2.3\n\n### 升级\n重启已有窗口。\n")
  try {
    return Bun.spawnSync([process.execPath, path.join(import.meta.dir, "release-notes.ts"), "v1.2.3"], {
      cwd,
      stdin: Buffer.from("## Generated commit summary\n- terse fix\n"),
      env: { ...process.env, GH_REPO: "owner/repo" },
      stdout: "pipe",
      stderr: "pipe",
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("publisher uses the curated English pair instead of the shorter draft changelog", () => {
  const result = publishFixture(true, true)
  expect(result.exitCode).toBe(0)
  const notes = result.stdout.toString()
  expect(notes).toContain("### Upgrading\nRestart existing windows.")
  expect(notes).toContain("https://github.com/owner/repo/blob/main/docs/releases/v1.2.3.zh.md")
  expect(notes).not.toContain("terse fix")
})

test("publisher rejects a missing English document", () => {
  const result = publishFixture(false, true)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("missing English release notes")
})

test("publisher rejects a missing Chinese document", () => {
  const result = publishFixture(true, false)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("missing Chinese release notes")
})
