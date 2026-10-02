/**
 * Tree-sitter parsers for shell commands, loaded on first use so startup never
 * pays for the WebAssembly runtime or grammars. One loader serves the V1 shell
 * tool and the V2 bash tool, so the runtime is initialized once per process.
 */
export * as ShellParser from "./parser"

import { fileURLToPath } from "url"
import type { Parser } from "web-tree-sitter"
import { lazy } from "../util/lazy"

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const runtime = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  return Parser
})

const load = async (wasm: string): Promise<Parser> => {
  const Parser = await runtime()
  const { Language } = await import("web-tree-sitter")
  const parser = new Parser()
  parser.setLanguage(await Language.load(resolveWasm(wasm)))
  return parser
}

export const bash = lazy(async () => {
  const { default: wasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  return load(wasm)
})

export const powershell = lazy(async () => {
  const { default: wasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  return load(wasm)
})
