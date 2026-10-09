import type { JsonSchema, ModelToolSchemaCompatibility } from "../../schema"
import { isRecord } from "../../utils/record"
import { GeminiToolSchema } from "./gemini-tool-schema"

const removeNullSchemas = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeNullSchemas)
  if (!isRecord(value)) return value
  const fields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "anyOf")
      .map(([key, field]) => [key, removeNullSchemas(field)]),
  )
  if (!Array.isArray(value.anyOf)) return fields
  const variants = value.anyOf.filter((variant) => !isRecord(variant) || variant.type !== "null").map(removeNullSchemas)
  if (variants.length === 1 && isRecord(variants[0])) return { ...fields, ...variants[0] }
  return { ...fields, anyOf: variants }
}

const tupleItemsSchema = (items: ReadonlyArray<unknown>) => {
  const projected = items.map(moonshotNode)
  if (projected.length === 0) return {}
  if (projected.length === 1) return projected[0]
  return { anyOf: projected }
}

const moonshotNode = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(moonshotNode)
  if (!isRecord(schema)) return schema
  if (typeof schema.$ref === "string") return { $ref: schema.$ref }
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "items" && Array.isArray(value)) return [[key, tupleItemsSchema(value)]]
      if (key === "prefixItems") {
        if ("items" in schema) return []
        return [["items", tupleItemsSchema(Array.isArray(value) ? value : [])]]
      }
      if (key === "unevaluatedItems") return []
      return [[key, moonshotNode(value)]]
    }),
  )
}

const moonshot = (schema: JsonSchema): JsonSchema => {
  const projected = moonshotNode(schema)
  return isRecord(projected) ? projected : {}
}

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const

// Anthropic and OpenAI reject any tool whose `input_schema` omits `type` or
// carries a top-level `anyOf`/`oneOf`/`allOf`, failing the whole request with
// `tools.N.custom.input_schema.type: Field required`. Tool schemas reach the
// protocols from many producers (Effect Schema, Zod, MCP servers, plugins), so
// every protocol normalizes at this boundary instead of trusting each producer.
// A schema that is already an object root with no top-level combinator passes
// through unchanged, so well-formed inputs stay byte-identical.
const objectRoot = (schema: JsonSchema): JsonSchema => {
  if (!isRecord(schema)) return { type: "object" }
  const combinator = COMBINATORS.find((key) => Array.isArray(schema[key]))
  if (combinator === undefined) return schema.type === "object" ? schema : { ...schema, type: "object" }
  const variants = (schema[combinator] as ReadonlyArray<unknown>).filter(isRecord)
  const properties = variants.reduce(
    (properties, variant) => ({ ...(isRecord(variant.properties) ? variant.properties : {}), ...properties }),
    isRecord(schema.properties) ? schema.properties : {},
  )
  return {
    ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== combinator)),
    type: "object",
    properties,
    additionalProperties: false,
  }
}

const openAI = (schema: JsonSchema): JsonSchema => {
  const normalized = removeNullSchemas(objectRoot(schema))
  return isRecord(normalized) ? normalized : { type: "object" }
}

const gemini = (schema: JsonSchema): JsonSchema => GeminiToolSchema.convert(schema) ?? {}

const modelCompatibility = (
  schema: JsonSchema,
  compatibility: ModelToolSchemaCompatibility | undefined,
): JsonSchema => {
  // Gemini's dialect accepts a root that is not an object, so its own converter
  // stays the final word. Every other route ends on `objectRoot` so a bad tool
  // schema cannot fail an entire Anthropic, Bedrock, or OpenAI request.
  if (compatibility === "gemini") return gemini(schema)
  if (compatibility === "moonshot") return objectRoot(moonshot(schema))
  return objectRoot(schema)
}

export const ToolSchemaProjection = {
  gemini,
  modelCompatibility,
  moonshot,
  openAI,
} as const
