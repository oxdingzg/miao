import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InstallationExecutable } from "@miao/core/installation/executable"

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
export const REQUIRED_SAVED_RULES_SNAPSHOT = 1

export type Capabilities = {
  name: string
  version: string
  protocol: number
  schema: number
  /** Host route manifest version; absent on engines that predate it. */
  routesSchema?: number
  /** Version of the short-lived read-only catalog command, when supported. */
  catalog?: number
  savedRulesSnapshot?: number
}

const EXE = process.platform === "win32" ? ".exe" : ""

/**
 * Install locations the release flow can write, most specific first. An
 * explicit `MIAO_ENGINE_BIN` always wins.
 */
const candidates = (executable: string, launcher?: string) => [
  ...(path.basename(executable).startsWith("miao") ? [path.join(path.dirname(executable), `miao-engine${EXE}`)] : []),
  ...(launcher && path.basename(launcher).startsWith("miao") && path.dirname(launcher) !== path.dirname(executable)
    ? [path.join(path.dirname(launcher), `miao-engine${EXE}`)]
    : []),
  path.join(os.homedir(), ".miao", "bin", `miao-engine${EXE}`),
  path.join(os.homedir(), ".local", "share", "miao-engine", "bin", `miao-engine${EXE}`),
  path.join(os.homedir(), ".local", "bin", `miao-engine${EXE}`),
]

export function capabilities(binary: string): Capabilities | undefined {
  const result = spawnSync(binary, ["--capabilities"], { encoding: "utf8", timeout: 5_000 })
  if (result.status !== 0 || !result.stdout) return undefined
  try {
    const value: unknown = JSON.parse(result.stdout)
    if (typeof value !== "object" || value === null) return undefined
    const wire = value as Record<string, unknown>
    if (wire.name !== "miao-engine") return undefined
    if (!isRevision(wire.protocol)) return undefined
    if (!isRevision(wire.schema)) return undefined
    if (typeof wire.version !== "string") return undefined
    // The engine writes snake_case (`routes_schema`); a probe fixture may carry
    // the camelCase spelling. Read either, refuse a frame that disagrees with
    // itself, and treat a frame with neither as an engine that predates the
    // field — that policy is unchanged, only the accepted encoding is wider.
    const camel = wire.routesSchema
    const snake = wire.routes_schema
    if (camel !== undefined && !isRevision(camel)) return undefined
    if (snake !== undefined && !isRevision(snake)) return undefined
    if (camel !== undefined && snake !== undefined && camel !== snake) return undefined
    const routesSchema = camel ?? snake
    if (wire.catalog !== undefined && !isRevision(wire.catalog)) return undefined
    if (wire.saved_rules_snapshot !== undefined && !isRevision(wire.saved_rules_snapshot)) return undefined
    return {
      name: "miao-engine",
      version: wire.version,
      protocol: wire.protocol,
      schema: wire.schema,
      ...(typeof routesSchema === "number" ? { routesSchema } : {}),
      ...(typeof wire.catalog === "number" ? { catalog: wire.catalog } : {}),
      ...(typeof wire.saved_rules_snapshot === "number" ? { savedRulesSnapshot: wire.saved_rules_snapshot } : {}),
    }
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
export function resolveEngine(
  input: {
    environment?: Record<string, string | undefined>
    probe?: (binary: string) => Capabilities | undefined
    exists?: (binary: string) => boolean
    executable?: string
    launcher?: string
    requireSavedRulesSnapshot?: boolean
  } = {},
): { binary: string; capabilities: Capabilities } | undefined {
  const environment = input.environment ?? process.env
  const probe = input.probe ?? capabilities
  const exists = input.exists ?? existsSync
  const compatible = (found: Capabilities) =>
    found.protocol >= REQUIRED_PROTOCOL &&
    (found.routesSchema === undefined || found.routesSchema >= REQUIRED_ROUTES_SCHEMA) &&
    (!input.requireSavedRulesSnapshot || (found.savedRulesSnapshot ?? 0) >= REQUIRED_SAVED_RULES_SNAPSHOT)
  const explicit = environment.MIAO_ENGINE_BIN
  if (explicit) {
    const found = exists(explicit) ? probe(explicit) : undefined
    if (!found || !compatible(found)) {
      throw new Error(
        found
          ? `MIAO_ENGINE_BIN=${explicit} reports protocol ${found.protocol} and route schema ${found.routesSchema ?? "unknown"} but this build requires protocol ${REQUIRED_PROTOCOL} and route schema ${REQUIRED_ROUTES_SCHEMA}${input.requireSavedRulesSnapshot ? ` and saved-rule snapshots ${REQUIRED_SAVED_RULES_SNAPSHOT}` : ""}`
          : `MIAO_ENGINE_BIN=${explicit} cannot report capabilities`,
      )
    }
    return { binary: explicit, capabilities: found }
  }
  const executable = input.executable ?? InstallationExecutable.executable
  const launcher = input.launcher ?? (input.executable === undefined ? InstallationExecutable.launcher : undefined)
  for (const binary of candidates(existsSync(executable) ? realpathSync(executable) : executable, launcher)) {
    if (!exists(binary)) continue
    const found = probe(binary)
    if (found && compatible(found)) return { binary, capabilities: found }
  }
  return undefined
}

let cached: { value: ReturnType<typeof resolveEngine> } | undefined

/** Cached process-environment discovery; the binary does not change mid-run. */
export function discoveredEngine(): string | undefined {
  cached ??= { value: resolveEngine({ requireSavedRulesSnapshot: true }) }
  return cached.value?.binary
}

/** Test seam: forget the cached discovery. */
export function resetDiscovery() {
  cached = undefined
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
