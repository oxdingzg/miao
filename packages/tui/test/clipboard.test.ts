import { existsSync } from "node:fs"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { copyCommand, readHostClipboardImage } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test("serves a fresh host clipboard image once and consumes it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "miao-clipboard-"))
  const file = path.join(dir, "paste.png")
  try {
    await writeFile(file, Buffer.from("89504e47", "hex"))
    const image = await readHostClipboardImage(file)
    expect(image?.mime).toBe("image/png")
    expect(existsSync(file)).toBe(false)
    expect(await readHostClipboardImage(file)).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ignores a stale host clipboard image", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "miao-clipboard-"))
  const file = path.join(dir, "paste.png")
  try {
    await writeFile(file, Buffer.from("89504e47", "hex"))
    const stale = new Date(Date.now() - 60_000)
    await utimes(file, stale, stale)
    expect(await readHostClipboardImage(file)).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("returns undefined without a host clipboard file", async () => {
  expect(await readHostClipboardImage(undefined)).toBeUndefined()
  expect(await readHostClipboardImage(path.join(tmpdir(), "miao-clipboard-missing.png"))).toBeUndefined()
})
