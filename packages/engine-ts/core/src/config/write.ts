export * as ConfigWrite from "./write"

import path from "path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Config } from "../config"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { ConfigMigrateV1 } from "../v1/config/migrate"

export class InvalidPatchError extends Schema.TaggedErrorClass<InvalidPatchError>()("ConfigWrite.InvalidPatchError", {
  message: Schema.String,
}) {}

export interface Result {
  /** The global config document as written. */
  readonly document: Record<string, unknown>
  readonly changed: boolean
  readonly file: string
  /** Where the V1 original was saved when this write migrated the file. */
  readonly backup?: string
}

export interface Interface {
  /**
   * Merge `patch` into the user's global config file (objects merge recursively, `null` removes a key).
   * A V1-shaped file is migrated to the V2 shape first and its original kept beside it, because V2 keys
   * written into a V1 document are ignored when the document is loaded.
   */
  readonly updateGlobal: (patch: Record<string, unknown>) => Effect.Effect<Result, InvalidPatchError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ConfigWrite") {}

const encodeInfo = Schema.encodeSync(Config.Info)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    return Service.of({
      updateGlobal: Effect.fn("ConfigWrite.updateGlobal")(function* (patch: Record<string, unknown>) {
        if (ConfigMigrateV1.isV1(patch))
          return yield* new InvalidPatchError({
            message: `Use V2 config keys; V1 keys are not accepted: ${Object.keys(patch).join(", ")}`,
          })
        const file = yield* targetFile(fs, global.config)
        const before = (yield* fs.readFileStringSafe(file).pipe(Effect.orDie)) ?? ""
        const current = parseText(before || "{}")
        if (Option.isNone(current))
          return yield* new InvalidPatchError({ message: `${file} is not valid JSON; fix it before saving settings` })
        const migrated = ConfigMigrateV1.isV1(current.value) ? migrate(current.value) : undefined
        if (migrated === null)
          return yield* new InvalidPatchError({ message: `${file} could not be read as a configuration` })
        const next = patchText(migrated ?? (before || "{}"), patch)
        const document = parseText(next).pipe(Option.filter((value) => !ConfigMigrateV1.isV1(value)))
        if (Option.isNone(document) || Option.isNone(Config.decodeDocument(document.value)))
          return yield* new InvalidPatchError({ message: "The change does not produce a valid configuration" })
        const result = { document: document.value as Record<string, unknown>, file }
        if (next === before) return { ...result, changed: false }
        const backup = migrated === undefined ? undefined : `${file}.v1-${Date.now()}.bak`
        if (backup) yield* fs.writeWithDirs(backup, before).pipe(Effect.orDie)
        yield* fs.writeWithDirs(file, next).pipe(Effect.orDie)
        return { ...result, changed: true, backup }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

// Write where a value cannot be overridden by another global file: the last one loaded, else a new miao.json.
const targetFile = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string) {
  const existing = yield* Effect.filter(
    Config.fileNames.map((name) => path.join(directory, name)),
    (file) => fs.existsSafe(file),
  )
  return existing.at(-1) ?? path.join(directory, "miao.json")
})

function parseText(text: string) {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) return Option.none()
  return Option.some(value)
}

// The same V1 → V2 migration a location applies when it loads the file, serialized as a V2 document.
function migrate(input: unknown) {
  const info = Config.decodeDocument(input)
  if (Option.isNone(info)) return null
  return JSON.stringify(encodeInfo(info.value), null, 2) + "\n"
}

function patchText(text: string, patch: unknown, at: string[] = []): string {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return applyEdits(
      text,
      modify(text, at, patch === null ? undefined : patch, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    )
  return Object.entries(patch).reduce((result, [key, value]) => patchText(result, value, [...at, key]), text)
}
