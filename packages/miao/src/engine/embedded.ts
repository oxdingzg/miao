import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationExecutable } from "@miao/core/installation/executable"
import { capabilities, resolveEngine, type Capabilities } from "./discovery"

const EXE = process.platform === "win32" ? ".exe" : ""

/**
 * The build embeds the engine with `import ... with { type: "file" }`. The
 * default export is a `/$bunfs/root/...` path string in a compiled binary and
 * a Blob otherwise.
 */
async function embeddedBytes(): Promise<Uint8Array | undefined> {
  try {
    // @ts-expect-error - generated file at build time
    const embedded = (await import("miao-engine.gen.ts")).default as Blob | string | undefined
    if (!embedded) return undefined
    if (typeof embedded === "string") return new Uint8Array(await Bun.file(embedded).arrayBuffer())
    return new Uint8Array(await embedded.arrayBuffer())
  } catch {
    return undefined
  }
}

export type EmbeddedEngine = { bytes: Uint8Array; sha256: string }

/** The engine binary baked into this executable, if the build embedded one. */
export async function loadEmbeddedEngine(): Promise<EmbeddedEngine | undefined> {
  const bytes = await embeddedBytes()
  if (!bytes) return undefined
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** Mirrors discovery's candidate order: beside a `miao*` executable first, then the shared install dir. */
export function engineTargets(input: { executable?: string; home?: string } = {}): string[] {
  const executable = input.executable ?? InstallationExecutable.executable
  const real = existsSync(executable) ? realpathSync(executable) : executable
  const beside = path.basename(real).startsWith("miao") ? path.join(path.dirname(real), `miao-engine${EXE}`) : undefined
  const home = input.home ?? os.homedir()
  return [...(beside ? [beside] : []), path.join(home, ".local", "share", "miao-engine", "bin", `miao-engine${EXE}`)]
}

async function extractTo(target: string, engine: EmbeddedEngine): Promise<void> {
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}`)
  try {
    await Bun.write(tmp, engine.bytes)
    if (process.platform !== "win32") await chmod(tmp, 0o755)
    await rename(tmp, target)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
  await Bun.write(`${target}.embedded.sha256`, engine.sha256)
}

/**
 * Materialize the embedded engine where candidate discovery looks. An
 * compatible operator-installed engine wins. Hash-marked extractions follow
 * this executable's embedded payload, so upgrading a host upgrades its managed
 * engine even when the wire protocol has not changed. Never throws:
 * a failed extraction must not block CLI startup.
 */
export async function ensureEmbeddedEngine(
  input: {
    executable?: string
    launcher?: string
    preferPaired?: boolean
    home?: string
    environment?: Record<string, string | undefined>
    load?: typeof loadEmbeddedEngine
    probe?: (binary: string) => Capabilities | undefined
    exists?: (binary: string) => boolean
  } = {},
): Promise<string | undefined> {
  if ((input.environment ?? process.env).MIAO_ENGINE_BIN) return undefined
  const engine = await (input.load ?? loadEmbeddedEngine)()
  if (!engine) return undefined
  const probe = input.probe ?? capabilities
  const exists = input.exists ?? existsSync
  const validate = (binary: string) =>
    resolveEngine({
      environment: { MIAO_ENGINE_BIN: binary },
      probe,
      exists: () => true,
      requireSavedRulesSnapshot: true,
    })
  const existing = resolveEngine({
    requireSavedRulesSnapshot: true,
    environment: {},
    probe,
    exists,
    executable: input.executable,
    launcher: input.launcher,
  })
  const targets = engineTargets(input)
  const preferred = targets[0]
  const executable = input.executable ?? InstallationExecutable.executable
  // New release builds carry their paired engine. Create it in this build's
  // own directory instead of replacing an installed engine that another
  // window may still be using (especially a locked executable on Windows).
  if (
    (input.preferPaired ?? InstallationExecutable.buildID !== "local") &&
    preferred &&
    path.dirname(preferred) === path.dirname(executable) &&
    existing?.binary !== preferred &&
    !exists(preferred)
  ) {
    try {
      await extractTo(preferred, engine)
      if (validate(preferred)) return preferred
    } catch {
      return undefined
    }
  }
  if (existing) {
    const marker = await readFile(`${existing.binary}.embedded.sha256`, "utf8").catch(() => "")
    if (!marker) return undefined
    const current = await Bun.file(existing.binary)
      .arrayBuffer()
      .catch(() => undefined)
    // A stale marker does not grant ownership over an operator's replacement.
    if (!current || createHash("sha256").update(new Uint8Array(current)).digest("hex") !== marker) return undefined
    if (marker === engine.sha256) return undefined
  }
  for (const target of new Set([...(existing ? [existing.binary] : []), ...targets])) {
    try {
      // No healthy matching extraction was found. Rewrite even when the marker
      // matches: an invalid/missing binary must not be trusted by marker alone.
      await extractTo(target, engine)
      if (validate(target)) return target
    } catch {
      // Unwritable candidate dir or a dead probe: fall through to the next target.
    }
  }
  return undefined
}
