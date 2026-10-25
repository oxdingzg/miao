import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureEmbeddedEngine, engineTargets } from "@/engine/embedded"
import type { Capabilities } from "@/engine/discovery"

const ok = (overrides: Partial<Capabilities> = {}) => (): Capabilities => ({
  name: "miao-engine",
  version: "0.0.1",
  protocol: 2,
  schema: 12,
  ...overrides,
})

const payload = (text: string) => new TextEncoder().encode(text)

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miao-embedded-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

test("targets mirror discovery: beside a miao executable first, then the shared dir", () => {
  expect(engineTargets({ executable: "/opt/bin/miao", home: "/h" })).toEqual([
    "/opt/bin/miao-engine",
    path.join("/h", ".local/share/miao-engine/bin/miao-engine"),
  ])
  expect(engineTargets({ executable: "/usr/bin/bun", home: "/h" })).toEqual([
    path.join("/h", ".local/share/miao-engine/bin/miao-engine"),
  ])
})

test("without an embedded engine nothing is written", async () => {
  await using tmp = await scratch()
  const result = await ensureEmbeddedEngine({ home: tmp.dir, load: async () => undefined })
  expect(result).toBeUndefined()
})

test("an installed compatible engine wins and the embedded copy stays dormant", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "#!/bin/sh\n")
  const result = await ensureEmbeddedEngine({
    executable,
    home: tmp.dir,
    load: async () => ({ bytes: payload("embedded"), sha256: "hash" }),
    probe: ok(),
    exists: () => true,
  })
  expect(result).toBeUndefined()
  expect(existsSync(path.join(tmp.dir, "miao-engine"))).toBe(false)
})

test("extracts beside the executable, and reuses a matching extraction", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "#!/bin/sh\n")
  // A temp dir is a symlink under macOS (/tmp -> /private/tmp), so the target
  // has to be the realpath the implementation resolves before it probes.
  const target = path.join(await realpath(tmp.dir), "miao-engine")
  const load = async () => ({ bytes: payload("ENGINE-1"), sha256: "hash-1" })
  const first = await ensureEmbeddedEngine({
    executable,
    home: tmp.dir,
    load,
    probe: (binary) => (binary === target ? ok()() : undefined),
  })
  expect(first).toBe(target)
  expect(await readFile(target, "utf8")).toBe("ENGINE-1")
  expect(await readFile(`${target}.embedded.sha256`, "utf8")).toBe("hash-1")
  const before = (await stat(target)).mtimeMs
  const retry = await ensureEmbeddedEngine({ executable, home: tmp.dir, load, probe: ok() })
  expect(retry).toBeUndefined()
  expect((await stat(target)).mtimeMs).toBe(before)
})

test("a probe that passes on first sight extracts once and reports the path", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "#!/bin/sh\n")
  const target = path.join(await realpath(tmp.dir), "miao-engine")
  const result = await ensureEmbeddedEngine({
    executable,
    home: tmp.dir,
    load: async () => ({ bytes: payload("ENGINE-2"), sha256: "hash-2" }),
    probe: ok(),
    exists: (binary) => binary === executable,
  })
  expect(result).toBe(target)
  expect(await readFile(target, "utf8")).toBe("ENGINE-2")
})

test("falls back to the shared install dir when the executable is not a miao binary", async () => {
  await using tmp = await scratch()
  const shared = path.join(tmp.dir, ".local/share/miao-engine/bin/miao-engine")
  const result = await ensureEmbeddedEngine({
    executable: path.join(tmp.dir, "bun"),
    home: tmp.dir,
    load: async () => ({ bytes: payload("ENGINE-3"), sha256: "hash-3" }),
    probe: ok(),
    exists: () => false,
  })
  expect(result).toBe(shared)
  expect(await readFile(shared, "utf8")).toBe("ENGINE-3")
})
