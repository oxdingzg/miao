import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capabilities, resolveEngine, type Capabilities } from "./discovery"

const EXE = process.platform === "win32" ? ".exe" : ""

async function embeddedBlob(): Promise<Blob | undefined> {
  try {
    // @ts-expect-error - generated file at build time
    return (await import("miao-engine.gen.ts")).default as Blob
  } catch {
    return undefined
  }
}

export type EmbeddedEngine = { bytes: Uint8Array; sha256: string }

/** The engine binary baked into this executable, if the build embedded one. */
export async function loadEmbeddedEngine(): Promise<EmbeddedEngine | undefined> {
  const blob = await embeddedBlob()
  if (!blob) return undefined
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** Mirrors discovery's candidate order: beside a `miao*` executable first, then the shared install dir. */
export function engineTargets(input: { executable?: string; home?: string } = {}): string[] {
  const executable = input.executable ?? process.execPath
  const real = existsSync(executable) ? realpathSync(executable) : executable
  const beside = path.basename(real).startsWith("miao")
    ? path.join(path.dirname(real), `miao-engine${EXE}`)
    : undefined
  const home = input.home ?? os.homedir()
  return [...(beside ? [beside] : []), path.join(home, ".local", "share", "miao-engine", "bin", `miao-engine${EXE}`)]
}

async function extractTo(target: string, engine: EmbeddedEngine): Promise<void> {
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}`)
  await Bun.write(tmp, engine.bytes)
  if (process.platform !== "win32") await chmod(tmp, 0o755)
  await rename(tmp, target)
  await Bun.write(`${target}.embedded.sha256`, engine.sha256)
}

/**
 * Materialize the embedded engine where candidate discovery looks. An
 * already-installed compatible engine always wins; the embedded copy only
 * fills the gap so a fresh single-file install works offline. Never throws:
 * a failed extraction must not block CLI startup.
 */
export async function ensureEmbeddedEngine(
  input: {
    executable?: string
    home?: string
    load?: typeof loadEmbeddedEngine
    probe?: (binary: string) => Capabilities | undefined
    exists?: (binary: string) => boolean
  } = {},
): Promise<string | undefined> {
  const engine = await (input.load ?? loadEmbeddedEngine)()
  if (!engine) return undefined
  const probe = input.probe ?? capabilities
  const exists = input.exists ?? existsSync
  const existing = resolveEngine({ environment: {}, probe, exists, executable: input.executable })
  if (existing) return undefined
  for (const target of engineTargets(input)) {
    try {
      const current = exists(target) ? await readFile(`${target}.embedded.sha256`, "utf8").catch(() => "") : ""
      if (current !== engine.sha256) await extractTo(target, engine)
      if (probe(target)) return target
    } catch {
      // Unwritable candidate dir or a dead probe: fall through to the next target.
    }
  }
  return undefined
}
