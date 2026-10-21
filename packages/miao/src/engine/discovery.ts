import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Engine-host contract this build requires. It moves only when a newer product
 * must not reuse an older engine (shared store, fenced Session ownership,
 * control routing); an engine that cannot report a protocol is older.
 */
export const REQUIRED_PROTOCOL = 2

/**
 * Route-manifest version this build writes. An engine that predates the field
 * is still accepted (it may serve a plain provider); one that reports a lower
 * version than this build writes is refused before startup, because its loader
 * would reject the manifest with an opaque parse error.
 */
export const REQUIRED_ROUTES_SCHEMA = 2

export type Capabilities = {
  name: string
  version: string
  protocol: number
  schema: number
  /** Host route manifest version; absent on engines that predate it. */
  routesSchema?: number
}

const EXE = process.platform === "win32" ? ".exe" : ""

/**
 * Install locations the release flow can write, most specific first. An
 * explicit `MIAO_ENGINE_BIN` always wins.
 */
const candidates = () => [
  path.join(os.homedir(), ".miao", "bin", `miao-engine${EXE}`),
  path.join(os.homedir(), ".local", "share", "miao-engine", "bin", `miao-engine${EXE}`),
  path.join(os.homedir(), ".local", "bin", `miao-engine${EXE}`),
]

export function capabilities(binary: string): Capabilities | undefined {
  const result = spawnSync(binary, ["--capabilities"], { encoding: "utf8", timeout: 5_000 })
  if (result.status !== 0 || !result.stdout) return undefined
  try {
    const value = JSON.parse(result.stdout) as Partial<Capabilities>
    if (value.name !== "miao-engine") return undefined
    if (typeof value.protocol !== "number") return undefined
    if (typeof value.schema !== "number") return undefined
    if (typeof value.version !== "string") return undefined
    if (value.routesSchema !== undefined && typeof value.routesSchema !== "number") return undefined
    return value as Capabilities
  } catch {
    return undefined
  }
}

/**
 * Resolve the engine this build may use without an environment variable. An
 * explicit `MIAO_ENGINE_BIN` that is too old is an error: the operator asked
 * for that binary, and silently falling back would hide a schema mismatch. A
 * discovered engine that is too old is ignored, so an upgraded product keeps
 * running TypeScript Sessions instead of refusing to start.
 */
export function resolveEngine(input: {
  environment?: Record<string, string | undefined>
  probe?: (binary: string) => Capabilities | undefined
  exists?: (binary: string) => boolean
} = {}): { binary: string; capabilities: Capabilities } | undefined {
  const environment = input.environment ?? process.env
  const probe = input.probe ?? capabilities
  const exists = input.exists ?? existsSync
  const compatible = (found: Capabilities) =>
    found.protocol >= REQUIRED_PROTOCOL &&
    (found.routesSchema === undefined || found.routesSchema >= REQUIRED_ROUTES_SCHEMA)
  const explicit = environment.MIAO_ENGINE_BIN
  if (explicit) {
    const found = exists(explicit) ? probe(explicit) : undefined
    if (!found || !compatible(found)) {
      throw new Error(
        found
          ? `MIAO_ENGINE_BIN=${explicit} reports protocol ${found.protocol} and route schema ${found.routesSchema ?? "unknown"} but this build requires protocol ${REQUIRED_PROTOCOL} and route schema ${REQUIRED_ROUTES_SCHEMA}`
          : `MIAO_ENGINE_BIN=${explicit} cannot report capabilities`,
      )
    }
    return { binary: explicit, capabilities: found }
  }
  for (const binary of candidates()) {
    if (!exists(binary)) continue
    const found = probe(binary)
    if (found && compatible(found)) return { binary, capabilities: found }
  }
  return undefined
}

let cached: { value: ReturnType<typeof resolveEngine> } | undefined

/** Cached process-environment discovery; the binary does not change mid-run. */
export function discoveredEngine(): string | undefined {
  cached ??= { value: resolveEngine() }
  return cached.value?.binary
}

/** Test seam: forget the cached discovery. */
export function resetDiscovery() {
  cached = undefined
}
