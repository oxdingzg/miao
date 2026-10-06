import { intro, log, outro } from "@clack/prompts"
import path from "path"
import { Effect } from "effect"

import { Global } from "@miao/core/global"
import { InstanceRef } from "@/effect/instance-ref"
import {
  MarketplaceInvalidError,
  PluginMarketplace,
  type Manifest,
  type Targets,
} from "../../plugin/marketplace"
import { Filesystem } from "@/util/filesystem"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"

const MANIFEST_FILES = ["marketplace.json", ".claude-plugin/marketplace.json", ".zcode-plugin/marketplace.json"]

async function findManifestFile(source: string): Promise<string> {
  if (!(await Filesystem.isDir(source))) return source
  for (const candidate of MANIFEST_FILES) {
    const file = path.join(source, candidate)
    if (await Filesystem.exists(file)) return file
  }
  throw new MarketplaceInvalidError(`no marketplace manifest found in ${source}`)
}

async function readManifest(source: string): Promise<{ manifest: Manifest; root: string | undefined }> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source)
    if (!response.ok) throw new MarketplaceInvalidError(`failed to fetch ${source}: ${response.status}`)
    return { manifest: PluginMarketplace.parseManifest(await response.json()), root: undefined }
  }
  const file = await findManifestFile(source)
  return { manifest: PluginMarketplace.parseManifest(await Filesystem.readJson(file)), root: path.dirname(file) }
}

export const MarketplaceCommand = effectCmd({
  command: "marketplace <source> [plugins..]",
  describe: "browse a Claude Code / ZCode style marketplace and install plugin assets",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "marketplace.json path or URL",
      })
      .positional("plugins", {
        type: "string",
        describe: "plugin names to install; omit to list what the marketplace offers",
        array: true,
      })
      .option("project", {
        type: "boolean",
        default: false,
        describe: "install into the project's .miao instead of global config",
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: "overwrite existing skills, commands and agents",
      }),
  handler: Effect.fn("Cli.marketplace")(function* (args) {
    const source = String(args.source ?? "").trim()
    if (!source) {
      UI.error("marketplace source is required")
      process.exitCode = 1
      return
    }
    const requested = (Array.isArray(args.plugins) ? args.plugins : [args.plugins].filter(Boolean)).map(String)

    UI.empty()
    intro(`Marketplace ${source}`)

    let manifest: Manifest
    let root: string | undefined
    try {
      const read = yield* Effect.promise(() => readManifest(source))
      manifest = read.manifest
      root = read.root
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }

    if (requested.length === 0) {
      if (manifest.name) log.message(`\u001b[1m${manifest.name}\u001b[0m — ${manifest.plugins.length} plugins`)
      for (const entry of manifest.plugins) {
        const meta = [entry.version, entry.category].filter(Boolean).join(" · ")
        log.message(`${entry.name}${meta ? `  (${meta})` : ""}${entry.description ? `\n  ${entry.description}` : ""}`)
      }
      log.message(`\nInstall with: miao marketplace ${source} <plugin...>`)
      return
    }

    const ctx = yield* InstanceRef
    const base = args.project ? (ctx ? path.join(ctx.directory, ".miao") : undefined) : Global.Path.config
    if (!base) {
      UI.error("project install needs a project context")
      process.exitCode = 1
      return
    }
    const targets: Targets = {
      skills: path.join(base, "skills"),
      commands: path.join(base, "commands"),
      agents: path.join(base, "agents"),
    }

    let failed = false
    for (const name of requested) {
      const entry = manifest.plugins.find((plugin) => plugin.name === name)
      if (!entry) {
        UI.error(`unknown plugin: ${name}`)
        failed = true
        continue
      }
      try {
        const dir = yield* Effect.promise(() =>
          PluginMarketplace.materialize({ fetch, tmp: Global.Path.tmp })(
            PluginMarketplace.resolveSource(root, entry.source),
            entry.name,
          ),
        )
        const installed = yield* Effect.promise(() => PluginMarketplace.install(dir, targets, Boolean(args.force)))
        const count = installed.skills.length + installed.commands.length + installed.agents.length
        const parts = [
          installed.skills.length ? `${installed.skills.length} skills` : undefined,
          installed.commands.length ? `${installed.commands.length} commands` : undefined,
          installed.agents.length ? `${installed.agents.length} agents` : undefined,
          installed.skipped.length ? `${installed.skipped.length} skipped` : undefined,
        ].filter(Boolean)
        if (count + installed.skipped.length === 0) {
          log.warn(`${name}: no skills, commands or agents to install`)
        } else {
          log.success(`${name}: ${parts.join(" · ")}`)
        }
      } catch (error) {
        UI.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        failed = true
      }
    }
    if (failed) process.exitCode = 1
    outro(args.project ? `Installed into ${base}` : "Installed into global config")
  }),
})
