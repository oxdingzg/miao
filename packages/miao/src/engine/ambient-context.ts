import { existsSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { InstructionContext } from "@miao/core/instruction-context"
import { Location } from "@miao/core/location"
import { PluginV2 } from "@miao/core/plugin"
import { Reference } from "@miao/core/reference"
import { SkillV2 } from "@miao/core/skill"
import { SystemContext } from "@miao/core/system-context"
import { Deferred, Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

/** File-backed sources retain their paths and native policy resources. Only
 * remote instructions and embedded skills need child-lifetime snapshots.
 */
export const prepare = Effect.fn("Engine.ambientContext")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
) {
  if (configuration.contextConfigFile && configuration.skillsConfigFile && configuration.referencesConfigFile)
    return { options: {}, refresh: Effect.void }
  const instructions = Option.getOrUndefined(yield* Effect.serviceOption(InstructionContext.Service))
  const skills = Option.getOrUndefined(yield* Effect.serviceOption(SkillV2.Service))
  const references = Option.getOrUndefined(yield* Effect.serviceOption(Reference.Service))
  const current = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if (!instructions && !skills && !references) return { options: {}, refresh: Effect.void }
  if (!current || current.directory !== location.directory)
    return yield* Effect.fail(
      new EngineError("engine_context_location", "native context Location does not match owner"),
    )
  const plugins = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
  if (plugins) yield* Deferred.await(plugins.booted)
  const automaticInstructions = !configuration.contextConfigFile && instructions
  const automaticSkills = !configuration.skillsConfigFile && skills
  const automaticReferences = !configuration.referencesConfigFile
  if ((automaticSkills || automaticInstructions) && !automaticReferences)
    return yield* Effect.fail(
      new EngineError(
        "engine_context_authority",
        "automatic instructions and skills require automatic references or explicit source manifests",
      ),
    )
  const files = automaticInstructions ? yield* automaticInstructions.ambient() : []
  if (files === SystemContext.unavailable)
    return yield* Effect.fail(
      new EngineError("engine_context_unavailable", "product ambient instructions are temporarily unavailable"),
    )
  const available = automaticSkills ? yield* automaticSkills.list() : []
  const skillSources = automaticSkills ? yield* automaticSkills.sources() : []
  const embedded = available.filter((skill) =>
    skillSources.some(
      (source) =>
        source.type === "embedded" &&
        source.skill.name === skill.name &&
        source.skill.content === skill.content &&
        source.skill.location === skill.location,
    ),
  )
  const directories = Array.from(
    new Set<string>(
      skillSources.flatMap((source) =>
        source.type === "directory" &&
        available.some((skill) => skill.location && contained(source.path, skill.location))
          ? [source.path]
          : [],
      ),
    ),
  )
  for (const skill of available) {
    const location = skill.location
    if (!location || embedded.includes(skill) || directories.some((directory) => contained(directory, location)))
      continue
    directories.push(path.dirname(location))
  }
  if (files.length > 16 || available.length > 64 || directories.length + (embedded.length ? 1 : 0) > 16)
    return yield* Effect.fail(new EngineError("engine_context_limit", "native Context source or skill limit exceeded"))
  const declared = automaticReferences && references ? yield* references.list() : []
  const sourcePathStem = (file: InstructionContext.File) =>
    URL.canParse(file.path) && /^https?:/.test(file.path)
      ? "instruction-" + createHash("sha256").update(file.path).digest("hex") + ".md"
      : file.path
  // The engine embeds these paths in its provider requests, so the directory
  // name must be a pure function of the bundle: a per-session temp name would
  // change the request prefix every session and collapse the provider prefix
  // cache (measured 2.7-9.5x native cost on gateway models, see
  // docs/experiments/2026-10-23-engine-cost-batch). Content-addressed
  // directories are shared read-only across sessions and reused unchanged;
  // the OS temp cleaner reclaims stale ones.
  const identity = JSON.stringify([
    embedded.map((skill) => [skill.name, skill.content]),
    files.map((file) => [sourcePathStem(file), sourcePathStem(file) === file.path ? "" : file.content]),
    directories,
    declared.filter((item) => !item.hidden).map((item) => item.path),
    [Boolean(automaticInstructions), Boolean(automaticSkills), Boolean(automaticReferences)],
  ])
  const directory = contextDirectoryName(identity)
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: () => new EngineError("engine_context_io", "could not create native context directory"),
  })
  const skillDirectory = path.join(directory, "embedded-skills")
  const sourcePath = (file: InstructionContext.File) =>
    URL.canParse(file.path) && /^https?:/.test(file.path) ? path.join(directory, sourcePathStem(file)) : file.path
  // Authority and manifest identities are fixed for a child's lifetime. Refresh
  // only updates already registered remote bodies; it cannot add filesystem grants.
  const grants = [
    // A reference can name a repository that was never cloned or a path that
    // was deleted after it was declared. The engine refuses an unknown grant
    // path, which would take the whole Session down; a missing grant is simply
    // not usable, so leave it out instead of failing the child.
    ...declared
      .filter((item) => !item.hidden && existsSync(item.path))
      .map((item) => ({ path: item.path, description: (item.description?.trim() || item.name).slice(0, 64) })),
    ...files
      .filter((file) => !contained(location.directory, sourcePath(file)))
      .map((file) => ({ path: sourcePath(file), description: "Product instruction source" })),
    ...directories
      .filter((directory) => !contained(location.directory, directory))
      .map((directory) => ({ path: directory, description: "Product skill directory" })),
    ...(embedded.length ? [{ path: skillDirectory, description: "Embedded product skills; read on demand" }] : []),
  ].filter((item, index, all) => all.findIndex((entry) => entry.path === item.path) === index)
  if (grants.length > 16)
    return yield* Effect.fail(
      new EngineError("engine_context_limit", "native Context supports at most 16 external reference grants"),
    )
  // Same-content sessions share this directory; writes stay idempotent and
  // atomic so a concurrent reader never observes a torn manifest.
  const writeAtomic = (target: string, data: string) => {
    const temporary = `${target}.tmp-${process.pid}`
    return Bun.write(temporary, data).then(() => rename(temporary, target))
  }
  const contextConfigFile = path.join(directory, "context.json")
  const skillsConfigFile = path.join(directory, "skills.json")
  const referencesConfigFile = path.join(directory, "references.json")
  const options = {
    ...(automaticInstructions ? { contextConfigFile, workspaceInstructions: false } : {}),
    ...(automaticSkills ? { skillsConfigFile } : {}),
    ...(automaticReferences ? { referencesConfigFile } : {}),
  }
  const refresh = Effect.gen(function* () {
    const observed = automaticInstructions ? yield* automaticInstructions.ambient() : []
    if (observed === SystemContext.unavailable)
      return yield* Effect.fail(
        new EngineError("engine_context_unavailable", "product ambient instructions are temporarily unavailable"),
      )
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of observed) {
          if (!files.some((registered) => registered.path === file.path) || sourcePath(file) === file.path) continue
          const temporary = sourcePath(file) + ".next"
          await Bun.write(temporary, file.content)
          await rename(temporary, sourcePath(file))
        }
      },
      catch: () => new EngineError("engine_context_io", "could not refresh native Context snapshots"),
    })
  })
  yield* Effect.tryPromise({
    try: async () => {
      if (automaticInstructions) {
        for (const file of files) {
          if (sourcePath(file) !== file.path) await writeAtomic(sourcePath(file), file.content)
        }
        await writeAtomic(
          contextConfigFile,
          JSON.stringify(
            files.map((file, index) => ({ label: "product-instruction-" + index, path: sourcePath(file) })),
          ),
        )
      }
      if (automaticSkills) {
        for (const skill of embedded) {
          await writeAtomic(
            path.join(skillDirectory, createHash("sha256").update(skill.name).digest("hex") + ".md"),
            `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description ?? "")}\n---\n${skill.content}`,
          )
        }
        await writeAtomic(
          skillsConfigFile,
          JSON.stringify([
            ...directories.map((path) => ({ path })),
            ...(embedded.length ? [{ path: skillDirectory }] : []),
          ]),
        )
      }
      if (automaticReferences) await writeAtomic(referencesConfigFile, JSON.stringify(grants))
    },
    catch: () => new EngineError("engine_context_io", "could not write native Context manifests"),
  })
  return { options, refresh }
})

/** Pure function of the bundle identity, so equal bundles share one directory. */
export const contextDirectoryName = (identity: string) =>
  path.join(os.tmpdir(), "miao-native-context-" + createHash("sha256").update(identity).digest("hex").slice(0, 16))

function contained(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
}

export * as AmbientContext from "./ambient-context"
