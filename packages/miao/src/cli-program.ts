export * as CliProgram from "./cli-program"

import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

/**
 * The argv prefix that re-runs this CLI with one subcommand.
 *
 * A source checkout must spawn the CLI entry, never `Bun.main`: under the test
 * runner `Bun.main` is the test file and under some embedders it is a wrapper,
 * so `bun run <Bun.main> <subcommand>` would launch the wrong program. A
 * compiled single-file binary has no entry file and re-executes itself.
 */
export function command(...args: string[]): string[] {
  const entry = cliEntry()
  if (entry === undefined) return [process.execPath, ...args]
  return [process.execPath, "run", entry, ...args]
}

/** Absolute `src/index.ts` path for a source checkout, or undefined for a compiled binary. */
function cliEntry() {
  if (!import.meta.url.startsWith("file:")) return undefined
  // This module lives at `src/cli-program.ts`, so the entry is its sibling.
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.ts")
  if (existsSync(candidate)) return candidate
  // A compiled binary bundles this module; `Bun.main` then names the executable
  // itself, whose `.ts` check fails, so fall through to a bare self-exec.
  return undefined
}
