/**
 * `@miao/native` loads the Rust addon (`miao-native.node`) built from
 * `crates/miao-native`. The addon is required with a literal path so Bun embeds
 * it into the compiled single-file binary; when it is absent (for example a dev
 * checkout without Rust) the require throws and `native` is `undefined`, letting
 * callers fall back to the TypeScript implementations.
 */
declare const require: (id: string) => unknown

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

export interface NativeGitEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface NativeModule {
  replaceOnly(content: string, oldString: string, newString: string, replaceAll?: boolean): string
  applyEdit(
    content: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): { content: string; additions: number; deletions: number }
  matchEdit(
    content: string,
    oldString: string,
    replaceAll?: boolean,
  ): { kind: string; find?: string | null; count?: number | null }
  diffStats(before: string, after: string): { additions: number; deletions: number }
  unifiedPatch(before: string, after: string, filePath: string): string
  deriveNewContents(chunks: NativePatchChunk[], filePath: string, originalText: string): NativeDeriveResult
  deriveNewContentsV2(chunks: NativePatchChunk[], filePath: string, originalText: string): NativeDeriveResult
  gitStatus(path: string): Array<NativeGitEntry>
  gitStatusAsync(path: string): Promise<Array<NativeGitEntry>>
  gitRevParse(path: string, rev: string): string
  gitRevParseAsync(path: string, rev: string): Promise<string>
  gitBlob(path: string, rev: string, file: string): { content: string; binary: boolean }
  gitBlobAsync(path: string, rev: string, file: string): Promise<{ content: string; binary: boolean }>
  gitWorktreeChanges(path: string): string[]
  gitWorktreeChangesAsync(path: string): Promise<string[]>
  gitMergeBase(path: string, a: string, b: string): string
  gitMergeBaseAsync(path: string, a: string, b: string): Promise<string>
  gitDiff(path: string): string
  gitDiffAsync(path: string): Promise<string>
  detectLineEnding(text: string): string
  normalizeLineEndings(text: string, eol: string): string
  countTokens(text: string, encoding?: string): number
  walkFiles(root: string, options?: { hidden?: boolean; gitignore?: boolean }): string[]
  sha256Hex(text: string): string
  blake3Hex(text: string): string
  shellAnalyze(
    command: string,
    dialect: string,
  ): {
    commands: Array<{ parts: Array<{ kind: string; text: string }>; tokens: string[]; source: string }>
  }
  sandboxSupported(): boolean
  sandboxProfile(workdirs: string[], allowPaths: string[], allowNetwork: boolean, compat: boolean): string
  sandboxRestrict(workdirs: string[], allowPaths: string[], allowNetwork: boolean): void
}

function load(): NativeModule | undefined {
  try {
    return require("./miao-native.node") as NativeModule
  } catch {
    return undefined
  }
}

export const native = load()
