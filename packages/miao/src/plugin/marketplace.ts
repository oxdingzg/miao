export * as PluginMarketplace from "./marketplace"

import fs from "node:fs/promises"
import path from "path"
import { Archive } from "@/util/archive"
import { Filesystem } from "@/util/filesystem"

/**
 * Marketplace compatibility for Claude Code / ZCode style `marketplace.json`
 * manifests: browse a marketplace and install a plugin's file-based assets
 * (skills, commands, agents) into miao's own config directories. MCP servers
 * and hooks stay out of scope — miao wires those through its own config.
 */

export type Entry = {
  name: string
  source: string
  description: string | undefined
  version: string | undefined
  category: string | undefined
}

export type Manifest = {
  name: string | undefined
  plugins: Entry[]
}

export class MarketplaceInvalidError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Tolerant on purpose: vendors add unknown fields; only name+source are load-bearing. */
export function parseManifest(input: unknown): Manifest {
  if (!isRecord(input) || !Array.isArray(input.plugins)) {
    throw new MarketplaceInvalidError("marketplace manifest has no plugins array")
  }
  const plugins: Entry[] = []
  for (const raw of input.plugins) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.source !== "string") continue
    plugins.push({
      name: raw.name,
      source: raw.source,
      description: typeof raw.description === "string" ? raw.description : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
      category: typeof raw.category === "string" ? raw.category : undefined,
    })
  }
  return { name: typeof input.name === "string" ? input.name : undefined, plugins }
}

export type Source = { kind: "url"; url: string } | { kind: "dir"; dir: string }

/** A plugin source is an absolute URL, or a directory path relative to the manifest's location. */
export function resolveSource(root: string | undefined, source: string): Source {
  if (/^https?:\/\//.test(source)) return { kind: "url", url: source }
  if (path.isAbsolute(source)) return { kind: "dir", dir: source }
  if (root !== undefined) return { kind: "dir", dir: path.join(root, source) }
  throw new MarketplaceInvalidError(`plugin source "${source}" is relative but the marketplace has no root`)
}

export type FetchDeps = {
  fetch: typeof fetch
  /** Scratch space for downloads and unpacked archives; created on demand. */
  tmp: string
}

/**
 * Turn a source into a local directory holding the plugin contents. A zip is
 * downloaded and unpacked; if the archive wraps everything in one directory,
 * that directory is the plugin root.
 */
export const materialize =
  (deps: FetchDeps) =>
  async (source: Source, name: string): Promise<string> => {
    if (source.kind === "dir") {
      if (!(await Filesystem.isDir(source.dir))) {
        throw new MarketplaceInvalidError(`plugin directory not found: ${source.dir}`)
      }
      return source.dir
    }
    await fs.mkdir(deps.tmp, { recursive: true })
    const slug = name.replace(/[^a-z0-9_-]+/gi, "_")
    const zip = path.join(deps.tmp, `marketplace-${slug}.zip`)
    const unpacked = path.join(deps.tmp, `marketplace-${slug}`)
    const response = await deps.fetch(source.url)
    if (!response.ok) throw new MarketplaceInvalidError(`failed to download ${source.url}: ${response.status}`)
    await Filesystem.write(zip, Buffer.from(await response.arrayBuffer()))
    await fs.rm(unpacked, { recursive: true, force: true })
    await fs.mkdir(unpacked, { recursive: true })
    await Archive.extractZip(zip, unpacked)
    return unwrap(unpacked)
  }

async function unwrap(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (dirs.length === 1 && entries.length === 1) {
    const inner = path.join(dir, dirs[0])
    // The wrap directory is scaffolding; descend until assets or real content appear.
    if ((await hasAssets(inner)) || (await hasPlugin(inner))) return inner
    return unwrap(inner)
  }
  return dir
}

async function hasPlugin(dir: string): Promise<boolean> {
  return Filesystem.exists(path.join(dir, ".claude-plugin", "plugin.json"))
}

const ASSET_DIRS = ["skills", "commands", "agents"]

async function hasAssets(dir: string): Promise<boolean> {
  for (const asset of ASSET_DIRS) {
    if (await Filesystem.isDir(path.join(dir, asset))) return true
  }
  return false
}

export type Targets = {
  skills: string
  commands: string
  agents: string
}

export type Installed = {
  skills: string[]
  commands: string[]
  agents: string[]
  skipped: string[]
}

/**
 * Copy a plugin's file-based assets into miao's config directories. Skills map
 * to skill folders (a directory holding a SKILL.md), commands and agents to
 * markdown files, preserving relative nesting. Existing targets are skipped
 * unless `force`.
 */
export async function install(pluginDir: string, targets: Targets, force: boolean): Promise<Installed> {
  const result: Installed = { skills: [], commands: [], agents: [], skipped: [] }
  await copySkills(path.join(pluginDir, "skills"), targets.skills, result, force)
  await copyFiles("commands", path.join(pluginDir, "commands"), targets.commands, result, force)
  await copyFiles("agents", path.join(pluginDir, "agents"), targets.agents, result, force)
  return result
}

async function copySkills(from: string, to: string, result: Installed, force: boolean) {
  if (!(await Filesystem.isDir(from))) return
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(from, entry.name)
    if (!(await Filesystem.exists(path.join(skillDir, "SKILL.md")))) continue
    const target = path.join(to, entry.name)
    if (!force && (await Filesystem.exists(target))) {
      result.skipped.push(`skill ${entry.name}`)
      continue
    }
    await fs.mkdir(to, { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(skillDir, target, { recursive: true })
    result.skills.push(entry.name)
  }
}

async function copyFiles(
  kind: "commands" | "agents",
  from: string,
  to: string,
  result: Installed,
  force: boolean,
) {
  if (!(await Filesystem.isDir(from))) return
  for await (const entry of walk(from)) {
    const target = path.join(to, path.relative(from, entry))
    if (!force && (await Filesystem.exists(target))) {
      result.skipped.push(path.relative(from, entry))
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(entry, target)
    result[kind].push(path.relative(from, entry))
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith(".md")) yield full
  }
}
