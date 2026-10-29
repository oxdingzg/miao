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
  savedPermissionMigration?: number
  permissionContextStore?: number
  permissionProjectHandoff?: number
  permissionContextHandoff?: number
  permissionSourceHandoff?: number
  permissionSourceInitialize?: number
  sharedPermissionRuntime?: number
  permissionChangefeed?: number
  permissionProjectStore?: number
  permissionImportChanges?: number
  productPermissionRequests?: number
  productPermissionReplies?: number
  productPermissionCancel?: number
  productPermissionDiagnostics?: number
  productPermissionAuto?: number
  permissionPatternChanges?: number
  permissionPatterns?: number
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
    if (wire.permission_import_changes !== undefined && !isRevision(wire.permission_import_changes)) return undefined
    if (wire.saved_permission_migration !== undefined && !isRevision(wire.saved_permission_migration)) return undefined
    if (wire.saved_rules_snapshot !== undefined && !isRevision(wire.saved_rules_snapshot)) return undefined
    if (wire.product_permission_requests !== undefined && !isRevision(wire.product_permission_requests))
      return undefined
    if (wire.product_permission_replies !== undefined && !isRevision(wire.product_permission_replies)) return undefined
    if (wire.product_permission_cancel !== undefined && !isRevision(wire.product_permission_cancel)) return undefined
    if (wire.product_permission_diagnostics !== undefined && !isRevision(wire.product_permission_diagnostics))
      return undefined
    if (wire.product_permission_auto !== undefined && !isRevision(wire.product_permission_auto)) return undefined
    if (wire.permission_pattern_changes !== undefined && !isRevision(wire.permission_pattern_changes)) return undefined
    if (wire.permission_patterns !== undefined && !isRevision(wire.permission_patterns)) return undefined
    if (wire.permission_project_handoff !== undefined && !isRevision(wire.permission_project_handoff)) return undefined
    if (wire.permission_context_handoff !== undefined && !isRevision(wire.permission_context_handoff)) return undefined
    if (wire.permission_source_initialize !== undefined && !isRevision(wire.permission_source_initialize))
      return undefined
    if (wire.shared_permission_runtime !== undefined && !isRevision(wire.shared_permission_runtime)) return undefined
    if (wire.permission_source_handoff !== undefined && !isRevision(wire.permission_source_handoff)) return undefined
    if (wire.permission_changefeed !== undefined && !isRevision(wire.permission_changefeed)) return undefined
    if (wire.permission_context_store !== undefined && !isRevision(wire.permission_context_store)) return undefined
    if (wire.permission_project_store !== undefined && !isRevision(wire.permission_project_store)) return undefined
    return {
      name: "miao-engine",
      version: wire.version,
      protocol: wire.protocol,
      schema: wire.schema,
      ...(typeof routesSchema === "number" ? { routesSchema } : {}),
      ...(typeof wire.catalog === "number" ? { catalog: wire.catalog } : {}),
      ...(typeof wire.permission_project_handoff === "number"
        ? { permissionProjectHandoff: wire.permission_project_handoff }
        : {}),
      ...(typeof wire.permission_context_handoff === "number"
        ? { permissionContextHandoff: wire.permission_context_handoff }
        : {}),
      ...(typeof wire.permission_changefeed === "number" ? { permissionChangefeed: wire.permission_changefeed } : {}),
      ...(typeof wire.permission_source_initialize === "number"
        ? { permissionSourceInitialize: wire.permission_source_initialize }
        : {}),
      ...(typeof wire.shared_permission_runtime === "number"
        ? { sharedPermissionRuntime: wire.shared_permission_runtime }
        : {}),
      ...(typeof wire.permission_source_handoff === "number"
        ? { permissionSourceHandoff: wire.permission_source_handoff }
        : {}),
      ...(typeof wire.permission_context_store === "number"
        ? { permissionContextStore: wire.permission_context_store }
        : {}),
      ...(typeof wire.permission_project_store === "number"
        ? { permissionProjectStore: wire.permission_project_store }
        : {}),
      ...(typeof wire.permission_import_changes === "number"
        ? { permissionImportChanges: wire.permission_import_changes }
        : {}),
      ...(typeof wire.saved_permission_migration === "number"
        ? { savedPermissionMigration: wire.saved_permission_migration }
        : {}),
      ...(typeof wire.saved_rules_snapshot === "number" ? { savedRulesSnapshot: wire.saved_rules_snapshot } : {}),
      ...(typeof wire.product_permission_requests === "number"
        ? { productPermissionRequests: wire.product_permission_requests }
        : {}),
      ...(typeof wire.product_permission_replies === "number"
        ? { productPermissionReplies: wire.product_permission_replies }
        : {}),
      ...(typeof wire.product_permission_cancel === "number"
        ? { productPermissionCancel: wire.product_permission_cancel }
        : {}),
      ...(typeof wire.product_permission_diagnostics === "number"
        ? { productPermissionDiagnostics: wire.product_permission_diagnostics }
        : {}),
      ...(typeof wire.product_permission_auto === "number"
        ? { productPermissionAuto: wire.product_permission_auto }
        : {}),
      ...(typeof wire.permission_pattern_changes === "number"
        ? { permissionPatternChanges: wire.permission_pattern_changes }
        : {}),
      ...(typeof wire.permission_patterns === "number" ? { permissionPatterns: wire.permission_patterns } : {}),
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
    requireSharedPermissions?: boolean
  } = {},
): { binary: string; capabilities: Capabilities } | undefined {
  const environment = input.environment ?? process.env
  const probe = input.probe ?? capabilities
  const exists = input.exists ?? existsSync
  const compatible = (found: Capabilities) =>
    found.protocol >= REQUIRED_PROTOCOL &&
    (found.routesSchema === undefined || found.routesSchema >= REQUIRED_ROUTES_SCHEMA) &&
    (!input.requireSavedRulesSnapshot || (found.savedRulesSnapshot ?? 0) >= REQUIRED_SAVED_RULES_SNAPSHOT) &&
    (!input.requireSharedPermissions || found.sharedPermissionRuntime === 1)
  const explicit = environment.MIAO_ENGINE_BIN
  if (explicit) {
    const found = exists(explicit) ? probe(explicit) : undefined
    if (!found || !compatible(found)) {
      throw new Error(
        found
          ? `MIAO_ENGINE_BIN=${explicit} reports protocol ${found.protocol} and route schema ${found.routesSchema ?? "unknown"} but this build requires protocol ${REQUIRED_PROTOCOL} and route schema ${REQUIRED_ROUTES_SCHEMA}${input.requireSavedRulesSnapshot ? ` and saved-rule snapshots ${REQUIRED_SAVED_RULES_SNAPSHOT}` : ""}${input.requireSharedPermissions ? " and shared permission Runtime 1" : ""}`
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
