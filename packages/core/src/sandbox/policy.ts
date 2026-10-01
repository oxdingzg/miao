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
 * shell prefixes vary (`sh: /path: ...`, `/bin/sh: /path: ...`,
 * `sh: 1: cannot create /path: ...`), so take the last `: `-separated field
 * before the marker and keep it from its first `/`.
 */
export function parseDeniedLine(line: string): string | undefined {
  const indexes = DENIAL_MARKERS.map((marker) => line.indexOf(marker)).filter((index) => index >= 0)
  if (indexes.length === 0) return undefined
  return normalizeDenied(line.slice(0, Math.min(...indexes)))
}

/**
 * Normalize a denied-path candidate to the path itself. Older `miao-run`
 * binaries cut at the first `/`, so their reports can carry the shell's own
 * path as a prefix (`/bin/sh: /Users/me/f.txt`).
 */
export function normalizeDenied(text: string): string | undefined {
  const field = text
    .replace(/[:\s]+$/, "")
    .split(": ")
    .findLast((item) => item.includes("/"))
  if (!field) return undefined
  const path = field.slice(field.indexOf("/")).replace(/^(.*?)['"`]?$/, "$1")
  return path.length > 0 ? path : undefined
}

/**
 * Client errors for a refused network connection. Seatbelt and Landlock make
 * `connect()` fail with EPERM, but tools such as curl and nc print their own
 * message without the errno text, so these only count when the sandbox denies
 * the network.
 */
export const NETWORK_MARKERS = [
  "Could not resolve host",
  "Couldn't connect to server",
  "Failed to connect to",
  "FailedToOpenSocket",
  "Network is unreachable",
  "nodename nor servname",
  "Temporary failure in name resolution",
  "getaddrinfo",
] as const

/**
 * Denial lines that name no path, such as a blocked network connection. They
 * cannot be fixed by allowing a directory, only by running without the sandbox.
 */
export function unmappedDenials(output: string, options: { readonly network: boolean }) {
  return output
    .split("\n")
    .filter(
      (line) =>
        (DENIAL_MARKERS.some((marker) => line.includes(marker)) && parseDeniedLine(line) === undefined) ||
        (!options.network && NETWORK_MARKERS.some((marker) => line.includes(marker))),
    )
}

const decodeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ denied: Schema.Array(Schema.String) })),
)

/** Parse a runner deny report. A missing or malformed report yields no paths. */
export function parseDenyReport(text: string): string[] {
  return Option.match(decodeReport(text), {
    onNone: () => [],
    onSome: (report) => [...new Set(report.denied.flatMap((item) => normalizeDenied(item) ?? []))],
  })
}

/** Read a runner deny report from disk; a missing file yields no paths. */
export async function readDenyReport(reportPath: string) {
  return parseDenyReport(
    await Bun.file(reportPath)
      .text()
      .catch(() => ""),
  )
}
