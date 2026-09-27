/**
 * Loads the `miao-native` addon once, gated by `MIAO_NATIVE`. Returns `undefined`
 * when the flag is off or the addon is not available, so callers can fall back to
 * the TypeScript implementations.
 *
 * The addon path is repo-relative (source/dev). The compiled single-file binary
 * does not ship it yet, so it falls back to TS there; wiring the addon into the
 * compiled binary is tracked as the packaging risk R1 in
 * `docs/rust-integration-risks.en.md`.
 */
import { createRequire } from "module"
import path from "path"
import { Flag } from "@miao/core/flag/flag"

export interface NativePatchChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  isEndOfFile?: boolean
}

export interface NativeDeriveResult {
  content: string
  unifiedDiff: string
  bom: boolean
}

export interface NativeModule {
  replaceOnly(content: string, oldString: string, newString: string, replaceAll?: boolean): string
  applyEdit(
    content: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): { content: string; additions: number; deletions: number }
  deriveNewContents(chunks: NativePatchChunk[], filePath: string, originalText: string): NativeDeriveResult
}

let resolved = false
let cached: NativeModule | undefined

export function native(): NativeModule | undefined {
  if (resolved) return cached
  resolved = true
  if (!Flag.MIAO_NATIVE) {
    cached = undefined
    return cached
  }
  try {
    const require = createRequire(import.meta.url)
    cached = require(path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")) as NativeModule
  } catch {
    cached = undefined
  }
  return cached
}
