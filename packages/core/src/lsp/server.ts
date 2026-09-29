export * as LSPServer from "./server"

import { LANGUAGE_EXTENSIONS } from "./language"

export interface ServerInfo {
  readonly id: string
  readonly command: ReadonlyArray<string>
  readonly extensions: ReadonlyArray<string>
  readonly environment?: Record<string, string>
  readonly initialization?: Record<string, unknown>
  readonly root?: (directory: string) => string
}

/**
 * Built-in language servers. The list is intentionally small and portable:
 * every entry is resolved through `which` at use time and skipped when absent.
 */
export const servers: ReadonlyArray<ServerInfo> = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  { id: "gopls", command: ["gopls"], extensions: [".go"] },
  { id: "rust", command: ["rust-analyzer"], extensions: [".rs"] },
  { id: "pyright", command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  { id: "clangd", command: ["clangd"], extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"] },
]

export const languageOf = (file: string): string => {
  const match = /\.[^./\\]+$/.exec(file)
  return (match ? LANGUAGE_EXTENSIONS[match[0] as keyof typeof LANGUAGE_EXTENSIONS] : undefined) ?? "plaintext"
}
