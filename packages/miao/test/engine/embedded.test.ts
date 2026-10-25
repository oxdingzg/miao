import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureEmbeddedEngine, engineTargets } from "@/engine/embedded"
import type { Capabilities } from "@/engine/discovery"

const ok =
  (overrides: Partial<Capabilities> = {}) =>
  (): Capabilities => ({
    name: "miao-engine",
    version: "0.0.1",
    protocol: 2,
    schema: 12,
    ...overrides,
  })

const EXE = process.platform === "win32" ? ".exe" : ""

const payload = (text: string) => new TextEncoder().encode(text)

test("a matching marker cannot hide a corrupt managed binary", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "launcher")
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
  const sha256 = createHash("sha256").update("ENGINE-NEW").digest("hex")
  await writeFile(target, "CORRUPT")
  await writeFile(`${target}.embedded.sha256`, sha256)
  expect(
    await ensureEmbeddedEngine({
      executable,
      home: tmp.dir,
      environment: {},
      load: async () => ({ bytes: payload("ENGINE-NEW"), sha256 }),
      probe: (binary) =>
        binary === target && Bun.file(target).size === payload("ENGINE-NEW").length ? ok()() : undefined,
      exists: (binary) => binary === executable || binary === target,
    }),
  ).toBe(target)
  expect(await readFile(target, "utf8")).toBe("ENGINE-NEW")
})

test("a managed compatible extraction refreshes when the embedded payload changes", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "launcher")
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
  await writeFile(target, "ENGINE-OLD")
  await writeFile(`${target}.embedded.sha256`, createHash("sha256").update("ENGINE-OLD").digest("hex"))
  const result = await ensureEmbeddedEngine({
    executable,
    home: tmp.dir,
    environment: {},
    load: async () => ({
      bytes: payload("ENGINE-NEW"),
      sha256: createHash("sha256").update("ENGINE-NEW").digest("hex"),
    }),
    probe: (binary) => (binary === target && existsSync(target) ? ok({ version: "0.3.6" })() : undefined),
  })
  expect(result).toBe(target)
  expect(await readFile(target, "utf8")).toBe("ENGINE-NEW")
  expect(await readFile(`${target}.embedded.sha256`, "utf8")).toBe(
    createHash("sha256").update("ENGINE-NEW").digest("hex"),
  )
})

test("an explicit engine leaves even a managed old extraction untouched", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "launcher")
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
  await writeFile(target, "ENGINE-OLD")
  await writeFile(`${target}.embedded.sha256`, createHash("sha256").update("ENGINE-OLD").digest("hex"))
  expect(
    await ensureEmbeddedEngine({
      executable,
      home: tmp.dir,
      environment: { MIAO_ENGINE_BIN: target },
      load: async () => {
        throw new Error("explicit engine must not load an embedded payload")
      },
      probe: () => undefined,
    }),
  ).toBeUndefined()
  expect(await readFile(target, "utf8")).toBe("ENGINE-OLD")
})

test("an operator replacement is preserved despite an old extraction marker", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "launcher")
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
  await writeFile(target, "OPERATOR-ENGINE")
  await writeFile(`${target}.embedded.sha256`, createHash("sha256").update("ENGINE-OLD").digest("hex"))
  expect(
    await ensureEmbeddedEngine({
      executable,
      home: tmp.dir,
      environment: {},
      load: async () => ({ bytes: payload("ENGINE-NEW"), sha256: "new" }),
      probe: (binary) => (binary === target ? ok()() : undefined),
    }),
  ).toBeUndefined()
  expect(await readFile(target, "utf8")).toBe("OPERATOR-ENGINE")
})

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miao-embedded-"))
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

test("targets mirror discovery: beside a miao executable first, then the shared dir", () => {
  expect(engineTargets({ executable: "/opt/bin/miao", home: "/h" })).toEqual([
    path.join("/opt/bin", `miao-engine${EXE}`),
    path.join("/h", `.local/share/miao-engine/bin/miao-engine${EXE}`),
  ])
  expect(engineTargets({ executable: "/usr/bin/bun", home: "/h" })).toEqual([
    path.join("/h", `.local/share/miao-engine/bin/miao-engine${EXE}`),
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
  expect(existsSync(path.join(tmp.dir, `miao-engine${EXE}`))).toBe(false)
})

test("extracts beside the executable, and reuses a matching extraction", async () => {
  await using tmp = await scratch()
  const executable = path.join(tmp.dir, "miao")
  await writeFile(executable, "#!/bin/sh\n")
  // A temp dir is a symlink under macOS (/tmp -> /private/tmp), so the target
  // has to be the realpath the implementation resolves before it probes.
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
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
  const target = path.join(await realpath(tmp.dir), `miao-engine${EXE}`)
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
  const shared = path.join(tmp.dir, `.local/share/miao-engine/bin/miao-engine${EXE}`)
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
