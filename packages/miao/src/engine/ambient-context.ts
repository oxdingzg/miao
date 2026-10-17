import { mkdtemp, rename, rm } from "node:fs/promises"
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
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-context-")),
      catch: () => new EngineError("engine_context_io", "could not create native context directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const skillDirectory = path.join(directory, "embedded-skills")
  const sourcePath = (file: InstructionContext.File) =>
    URL.canParse(file.path) && /^https?:/.test(file.path)
      ? path.join(directory, "instruction-" + createHash("sha256").update(file.path).digest("hex") + ".md")
      : file.path
  const declared = automaticReferences && references ? yield* references.list() : []
  // Authority and manifest identities are fixed for a child's lifetime. Refresh
  // only updates already registered remote bodies; it cannot add filesystem grants.
  const grants = [
    ...declared
      .filter((item) => !item.hidden)
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
          if (sourcePath(file) !== file.path) await Bun.write(sourcePath(file), file.content)
        }
        await Bun.write(
          contextConfigFile,
          JSON.stringify(
            files.map((file, index) => ({ label: "product-instruction-" + index, path: sourcePath(file) })),
          ),
        )
      }
      if (automaticSkills) {
        for (const skill of embedded) {
          await Bun.write(
            path.join(skillDirectory, createHash("sha256").update(skill.name).digest("hex") + ".md"),
            `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description ?? "")}\n---\n${skill.content}`,
          )
        }
        await Bun.write(
          skillsConfigFile,
          JSON.stringify([
            ...directories.map((path) => ({ path })),
            ...(embedded.length ? [{ path: skillDirectory }] : []),
          ]),
        )
      }
      if (automaticReferences) await Bun.write(referencesConfigFile, JSON.stringify(grants))
    },
    catch: () => new EngineError("engine_context_io", "could not write native Context manifests"),
  })
  return { options, refresh }
})

function contained(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
}

export * as AmbientContext from "./ambient-context"
