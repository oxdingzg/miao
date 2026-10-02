// Loads third-party connectors listed in `remote.connectors`. A spec is either
// a local path (absolute, ./relative, ~/, or file:) or an npm package name; the
// caller decides how npm packages are installed and passes the module location.
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { connectorsOf, type Connector } from "./connector"

export type LoadResult = {
  readonly connectors: ReadonlyArray<Connector>
  readonly errors: ReadonlyArray<{ readonly spec: string; readonly error: string }>
}

export async function loadConnectors(input: {
  readonly builtins: ReadonlyArray<Connector>
  readonly specs: ReadonlyArray<string>
  /** Turns an npm package spec into an importable file path or URL (installing it when needed). */
  readonly install: (spec: string) => Promise<string>
  /** Directory relative paths are resolved against. */
  readonly cwd?: string
}): Promise<LoadResult> {
  const connectors = [...input.builtins]
  const errors: Array<{ spec: string; error: string }> = []
  for (const spec of input.specs) {
    const loaded = await importSpec(spec)
      .then((module) => ({ ok: true as const, found: connectorsOf(module) }))
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
    if (!loaded.ok) {
      errors.push({ spec, error: loaded.error })
      continue
    }
    if (loaded.found.length === 0) {
      errors.push({ spec, error: "模块没有导出 defineConnector(...) 定义的连接器" })
      continue
    }
    loaded.found.forEach((connector) => {
      if (connectors.some((existing) => existing.id === connector.id)) {
        errors.push({ spec, error: `连接器 id "${connector.id}" 已被占用，已跳过` })
        return
      }
      connectors.push(connector)
    })
  }
  return { connectors, errors }

  async function importSpec(spec: string) {
    const local = localPath(spec, input.cwd ?? process.cwd())
    const target = local ? pathToFileURL(local).href : await input.install(spec)
    return import(target)
  }
}

/** The absolute path of a local spec, or undefined for an npm package name. */
export function localPath(spec: string, cwd: string) {
  if (spec.startsWith("file:")) return new URL(spec).pathname
  if (spec.startsWith("~/")) return path.join(os.homedir(), spec.slice(2))
  if (path.isAbsolute(spec)) return spec
  if (spec.startsWith("./") || spec.startsWith("../")) return path.resolve(cwd, spec)
  return undefined
}
