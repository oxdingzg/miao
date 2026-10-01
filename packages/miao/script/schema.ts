#!/usr/bin/env bun

import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@miao/core/config"
import { ConfigV1 } from "@miao/core/v1/config/config"
import { TuiConfig } from "@miao/tui/config"
import { Schema } from "effect"

type JsonSchema = Record<string, unknown>
const MODEL_REF = "https://models.dev/model-schema.json#/$defs/Model"

function generateEffect(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(schema)
  const normalized = normalize({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    $defs: document.definitions,
  })
  if (!isRecord(normalized)) throw new Error("schema generator produced a non-object schema")
  const restored = restoreModelRefs(normalized)
  if (!isRecord(restored)) throw new Error("schema generator produced a non-object schema")
  restored.allowComments = true
  restored.allowTrailingCommas = true
  return restored
}

// One miao.json is read by both runtimes, and each schema rejects unknown keys,
// so the published schema is their union: every key either runtime accepts, and
// a key the two define differently accepts either shape.
function generateConfig() {
  const v1 = generateEffect(ConfigV1.Info)
  const v2 = generateEffect(ConfigV2.Info)
  const v1Defs = recordOf(v1.$defs)
  const renames = new Map(
    Object.entries(recordOf(v2.$defs))
      .filter(([name, def]) => name in v1Defs && JSON.stringify(v1Defs[name]) !== JSON.stringify(def))
      .map(([name]) => [name, `V2.${name}`]),
  )
  const v2Renamed = recordOf(renameRefs(v2, renames))
  const v2Defs = Object.fromEntries(
    Object.entries(recordOf(v2Renamed.$defs)).map(([name, def]) => [renames.get(name) ?? name, def]),
  )
  const v1Root = rootOf(v1, v1Defs)
  const v2Root = rootOf(v2Renamed, v2Defs)
  const v1Props = recordOf(v1Root.properties)
  const v2Props = recordOf(v2Root.properties)
  const properties = Object.fromEntries(
    [...new Set([...Object.keys(v1Props), ...Object.keys(v2Props)])].map((key) => {
      const a = v1Props[key]
      const b = v2Props[key]
      if (a === undefined || shape(a) === shape(b)) return [key, b ?? a]
      if (b === undefined) return [key, a]
      const description = recordOf(b).description ?? recordOf(a).description
      return [key, { ...(description === undefined ? {} : { description }), anyOf: [a, b] }]
    }),
  )
  return {
    $schema: v1.$schema,
    type: "object",
    properties,
    additionalProperties: false,
    $defs: { ...v1Defs, ...v2Defs },
    allowComments: true,
    allowTrailingCommas: true,
  }
}

// Two definitions that differ only in their prose accept the same documents.
function shape(value: unknown) {
  return JSON.stringify(value, (key, item) => (key === "description" ? undefined : item))
}

function rootOf(schema: JsonSchema, defs: JsonSchema): JsonSchema {
  const ref = schema.$ref
  if (typeof ref !== "string") return schema
  return recordOf(defs[ref.replace("#/$defs/", "")])
}

function renameRefs(value: unknown, renames: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => renameRefs(item, renames))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== "$ref" || typeof item !== "string") return [key, renameRefs(item, renames)]
      const name = item.replace("#/$defs/", "")
      return [key, renames.has(name) ? `#/$defs/${renames.get(name)}` : item]
    }),
  )
}

function recordOf(value: unknown): JsonSchema {
  return isRecord(value) ? value : {}
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))

  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf.filter((item) => !isRecord(item) || item.type !== "null")
    if (anyOf.length !== schema.anyOf.length) {
      const { anyOf: _, ...rest } = schema
      if (anyOf.length === 1 && isRecord(anyOf[0])) return normalize({ ...anyOf[0], ...rest })
      return { ...rest, anyOf }
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && isRecord(schema.allOf[0])) {
    const { allOf: _, ...rest } = schema
    return normalize({ ...schema.allOf[0], ...rest })
  }

  if (schema.type === "integer" && schema.maximum === undefined) {
    return { ...schema, maximum: Number.MAX_SAFE_INTEGER }
  }

  return schema
}

function restoreModelRefs(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreModelRefs(item))
  if (!isRecord(value)) return value

  const schema = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, restoreModelRefs(item, name)]))
  if ((key === "model" || key === "small_model") && schema.type === "string") {
    return { ...schema, $ref: MODEL_REF }
  }
  return schema
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const configFile = process.argv[2]
const tuiFile = process.argv[3]

console.log(configFile)
await Bun.write(configFile, JSON.stringify(generateConfig(), null, 2))

if (tuiFile) {
  console.log(tuiFile)
  await Bun.write(tuiFile, JSON.stringify(generateEffect(TuiConfig.Info), null, 2))
}
