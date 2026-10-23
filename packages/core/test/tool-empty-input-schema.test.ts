import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "@miao/core/tool/tool"

describe("Tool definition input schema", () => {
  test("a no-input tool advertises an object schema, not Effect's object/array union", () => {
    const tool = Tool.make({
      description: "List background jobs",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed([]),
    })

    // OpenAI-compatible function calling requires `parameters` to be a JSON
    // Schema of `type: "object"` at the top level; Effect lowers an empty
    // Struct to `anyOf: [object, array]`, which strict gateways reject with a
    // 400 for the whole request.
    expect(Tool.definition("job_list", tool).inputSchema).toEqual({ type: "object", properties: {} })
  })

  test("a fielded input keeps its object schema", () => {
    const tool = Tool.make({
      description: "Read a file",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed(""),
    })

    expect(Tool.definition("read_file", tool).inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })
  })
})
