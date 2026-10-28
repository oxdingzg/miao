export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigV1 } from "./v1/config/config"
import { Directory, Document, Info, type Entry } from "@miao/schema/config"
export { Directory, Document, type Entry, Info } from "@miao/schema/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"
import { ConfigErrorV1 } from "./v1/config/error"
import { ConfigExplain } from "./config/explain"
import { ConfigDiagnostics } from "./config/diagnostics"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep-merge plain objects; arrays and scalars from `patch` replace the base. */
const mergeConfig = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value
  }
  return result
}

/** Merge config documents from lowest to highest priority into one object. */
export const merge = (entries: readonly Entry[]): Record<string, unknown> => {
  let merged: Record<string, unknown> = {}
  for (const entry of entries) {
    if (entry.type !== "document") continue
    merged = mergeConfig(merged, entry.info as unknown as Record<string, unknown>)
  }
  return merged
}

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

/** Config file names read from each config directory, lowest to highest priority. */
export const fileNames = ["miao.json", "miao.jsonc", "opencode.json", "opencode.jsonc"] as const

/** Best-effort JSONC text parse for readers outside the Config service (the engine's global-file read). */
export const parseJsonc = (text: string): unknown => parse(text, [], { allowTrailingComma: true })

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

/** Decodes a parsed document the way a location loads it: a document with any V1 key is migrated as a whole. */
export const decodeDocument = (input: unknown) =>
  ConfigMigrateV1.isV1(input)
    ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
    : decodeInfo(input)

/** One ordered configuration source: the shape the engine's `--config-sources` reads. */
export type Source = { dir: string } | { file: string } | { content: string }

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /**
   * Returns the ordered source plan behind `entries`, lowest to highest
   * priority. S5 transition readers only: the real layer provides it, test
   * doubles that do not feed the engine may omit it.
   */
  readonly sources?: () => Effect.Effect<Source[]>
  /**
   * Returns where every effective value came from, which document won and
   * which values it overrode, with each document's scope. Readers that report
   * configuration to a user (CLI, HTTP) use this; test doubles may omit it.
   */
  readonly explain?: () => Effect.Effect<ConfigExplain.Explanation>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Config") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service

    // A `Document` is a schema class, so loader-only facts (which keys the
    // strict decode refused) are kept beside the entry rather than on it.
    const diagnostics = new WeakMap<object, readonly ConfigDiagnostics.Diagnostic[]>()

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileString(filepath).pipe(
        // A missing file is the normal end of discovery; an unreadable one is
        // an operator-visible problem the engine also refuses (S5 failure
        // strategy: neither side stays silent).
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      )
      if (text === undefined || text === "") return
      return yield* parseDocument(text, filepath)
    })

    // A malformed or schema-invalid document fails with its file and key
    // paths instead of silently disappearing: the engine refuses the same
    // document, and the S5 failure strategy forbids one side staying silent.
    const parseDocument = (text: string, filepath?: string) =>
      Effect.gen(function* () {
        const origin = filepath ?? "inline config"
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length)
          return yield* Effect.fail(
            new ConfigErrorV1.JsonError({
              path: origin,
              message: errors.map((error) => `${error.error} at offset ${error.offset}`).join("; "),
            }),
          )
        const invalid = (error: { message: string }) =>
          new ConfigErrorV1.InvalidError({ path: origin, message: error.message })
        const info = yield* ConfigMigrateV1.isV1(input)
          ? Effect.mapError(
              Effect.flatMap(Schema.decodeUnknownEffect(ConfigV1.Info, decodeOptions)(input), (v1) =>
                Schema.decodeUnknownEffect(Info, decodeOptions)(ConfigMigrateV1.migrate(v1)),
              ),
              invalid,
            )
          : Effect.mapError(Schema.decodeUnknownEffect(Info, decodeOptions)(input), invalid)
        const document = new Document({ type: "document", path: filepath, info })
        // The tolerant decode above stays authoritative: an unknown key never
        // stops this location from opening. The strict pass only records which
        // keys were ignored, so the report can name the file, the key path and
        // the value instead of dropping them silently. V1 documents are probed
        // after migration, the same transform the load path applies, so their
        // own keys are not mistaken for unknown ones.
        const probed = ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(
              Option.map(ConfigMigrateV1.migrate),
              Option.getOrElse(() => input),
            )
          : input
        const found = ConfigDiagnostics.of(probed)
        if (found.length) diagnostics.set(document, found)
        return document
      })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(fileNames, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    // Environment overrides, in the order V1 applies them: MIAO_CONFIG after the
    // global config, MIAO_CONFIG_DIR as the last config directory, and
    // MIAO_CONFIG_CONTENT above everything. MIAO_DISABLE_PROJECT_CONFIG skips the
    // project's files and directories.
    const customFile = process.env.MIAO_CONFIG
    const customDirectory = process.env.MIAO_CONFIG_DIR
    const customContent = process.env.MIAO_CONFIG_CONTENT
    const discovered =
      locationIsGlobal || Flag.MIAO_DISABLE_PROJECT_CONFIG
        ? []
        : yield* fs
            .up({
              targets: [".miao", ".opencode", ...fileNames.toReversed()],
              start: location.directory,
              stop: location.project.directory,
            })
            .pipe(Effect.orDie)
    const projectDirectories = discovered
      .filter((item) => [".miao", ".opencode"].includes(path.basename(item)))
      .toReversed()
      .map((directory) => AbsolutePath.make(directory))
    const directories = [
      globalDirectory,
      ...projectDirectories,
      ...(customDirectory ? [AbsolutePath.make(path.resolve(customDirectory))] : []),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => ![".miao", ".opencode"].includes(path.basename(item))).toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.miao` files.
    const custom = customFile ? yield* loadFile(path.resolve(customFile)).pipe(Effect.orDie) : undefined
    const content = customContent ? yield* parseDocument(customContent) : undefined
    const scoped = [
      ...(supplementary[0] ?? []).map((entry) => ({ entry, scope: "global" as const })),
      ...(custom ? [{ entry: custom, scope: "env" as const }] : []),
      ...direct.map((entry) => ({ entry, scope: "project" as const })),
      ...supplementary.slice(1).flatMap((entries, index) =>
        entries.map((entry) => ({
          entry,
          scope: index < projectDirectories.length ? ("local" as const) : ("env" as const),
        })),
      ),
      ...(content ? [{ entry: content, scope: "env" as const }] : []),
    ]
    const configs = scoped.map((item) => item.entry)
    const explained = scoped.map((item) => ({ ...item, diagnostics: diagnostics.get(item.entry) }))
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    // The source plan mirrors `configs` exactly: global directory, the custom
    // file, config files discovered between the project root and this
    // directory (nearest last), the remaining `.miao`/`.opencode` directories
    // and a custom directory, then inline content last.
    const sources: Source[] = [
      { dir: globalDirectory },
      ...(custom ? [{ file: path.resolve(customFile!) }] : []),
      ...directPaths.map((file) => ({ file })),
      ...directories.slice(1).map((directory) => ({ dir: directory })),
      ...(content ? [{ content: customContent! }] : []),
    ]

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
      sources: Effect.fn("Config.sources")(function* () {
        return sources
      }),
      explain: Effect.fn("Config.explain")(function* () {
        return ConfigExplain.explain(explained)
      }),
    })
  }).pipe(
    // A config the engine would refuse must refuse here too, loudly. The
    // failure is a defect on purpose: there is no recovering a Location whose
    // authority documents do not parse, and keeping the error channel typed
    // would push config errors into every graph that touches Config.
    Effect.orDie,
  ),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
