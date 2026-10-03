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

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

/** Decodes a parsed document the way a location loads it: a document with any V1 key is migrated as a whole. */
export const decodeDocument = (input: unknown) =>
  ConfigMigrateV1.isV1(input)
    ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
    : decodeInfo(input)

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Config") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      return parseDocument(text, filepath)
    })

    const parseDocument = (text: string, filepath?: string) => {
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      const info = Option.getOrUndefined(decodeDocument(input))
      if (!info) return
      return new Document({ type: "document", path: filepath, info })
    }

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
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => [".miao", ".opencode"].includes(path.basename(item)))
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
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
    const content = customContent ? parseDocument(customContent) : undefined
    const configs = [
      ...(supplementary[0] ?? []),
      ...(custom ? [custom] : []),
      ...direct,
      ...supplementary.slice(1).flat(),
      ...(content ? [content] : []),
    ]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
