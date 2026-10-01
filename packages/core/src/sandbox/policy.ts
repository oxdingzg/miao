export * as SandboxPolicy from "./policy"

import { Option, Schema } from "effect"
import type { ConfigSandbox } from "../config/sandbox"

/** Markers a shell prints when the OS sandbox blocks an operation. */
export const DENIAL_MARKERS = ["Operation not permitted", "Permission denied"] as const

export interface Settings {
  readonly enabled: boolean
  readonly network: boolean
  readonly writableRoots: readonly string[]
  readonly onUnavailable: "warn" | "fail"
}

/**
 * Merge sandbox config documents (lowest to highest priority) with the
 * environment. `MIAO_SANDBOX` and `MIAO_SANDBOX_DENY_NETWORK` override config in
 * both directions: `1`/`true` turns the setting on and any other non-empty value
 * turns it off. Extra writable roots accumulate across documents.
 */
export function settings(
  configs: readonly ConfigSandbox.Info[],
  env: Readonly<Record<string, string | undefined>>,
): Settings {
  const mode = configs.findLast((config) => config.mode !== undefined)?.mode
  const network = configs.findLast((config) => config.network !== undefined)?.network
  const enabled = envSwitch(env.MIAO_SANDBOX)
  const denyNetwork = envSwitch(env.MIAO_SANDBOX_DENY_NETWORK)
  return {
    enabled: enabled ?? mode === "workspace-write",
    network: denyNetwork === undefined ? (network ?? true) : !denyNetwork,
    writableRoots: configs.flatMap((config) => config.writable_roots ?? []),
    onUnavailable: configs.findLast((config) => config.on_unavailable !== undefined)?.on_unavailable ?? "warn",
  }
}

function envSwitch(value: string | undefined) {
  if (value === undefined || value === "") return undefined
  return ["1", "true"].includes(value.toLowerCase())
}

export interface ArgsInput {
  readonly command: readonly string[]
  readonly workdirs: readonly string[]
  readonly allowNetwork?: boolean
  readonly compat?: boolean
}

/** Build the runner arguments shared by `miao-run` and `miao __sandbox-run`. */
export function args(input: ArgsInput, allowPaths: readonly string[], reportPath: string) {
  return [
    ...input.workdirs.flatMap((workdir) => ["--workdir", workdir]),
    ...allowPaths.flatMap((allowPath) => ["--allow-path", allowPath]),
    ...(input.allowNetwork ? ["--allow-network"] : []),
    ...(input.compat ? ["--compat"] : []),
    "--deny-report",
    reportPath,
    "--",
    ...input.command,
  ]
}

/**
 * Extract the blocked path from a shell error line. macOS seatbelt reports
 * `Operation not permitted`; Linux Landlock reports `Permission denied`, and
 * shell prefixes vary (`sh: /path: ...`, `sh: 1: cannot create /path: ...`), so
 * take everything from the first `/` up to the marker.
 */
export function parseDeniedLine(line: string): string | undefined {
  const indexes = DENIAL_MARKERS.map((marker) => line.indexOf(marker)).filter((index) => index >= 0)
  if (indexes.length === 0) return undefined
  const at = Math.min(...indexes)
  const slash = line.slice(0, at).indexOf("/")
  if (slash < 0) return undefined
  const path = line.slice(slash, at).replace(/[:\s]+$/, "")
  return path.length > 0 ? path : undefined
}

/**
 * Denial lines that name no path, such as a blocked network connection. They
 * cannot be fixed by allowing a directory, only by running without the sandbox.
 */
export function unmappedDenials(output: string) {
  return output
    .split("\n")
    .filter((line) => DENIAL_MARKERS.some((marker) => line.includes(marker)) && parseDeniedLine(line) === undefined)
}

const decodeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ denied: Schema.Array(Schema.String) })),
)

/** Parse a runner deny report. A missing or malformed report yields no paths. */
export function parseDenyReport(text: string): string[] {
  return Option.match(decodeReport(text), { onNone: () => [], onSome: (report) => [...report.denied] })
}

/** Read a runner deny report from disk; a missing file yields no paths. */
export async function readDenyReport(reportPath: string) {
  return parseDenyReport(
    await Bun.file(reportPath)
      .text()
      .catch(() => ""),
  )
}
