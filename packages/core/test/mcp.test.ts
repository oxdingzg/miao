import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { Config } from "@miao/core/config"
import { ConfigMCP } from "@miao/core/config/mcp"
import { MCP } from "@miao/core/mcp"
import { AgentV2 } from "@miao/core/agent"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { testEffect } from "./lib/effect"

const fixture = path.resolve(import.meta.dir, "fixture/mock-mcp.ts")
const it = testEffect(Layer.empty)

const withMCP = <A, E, R>(
  entries: Config.Entry[],
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) => {
  const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))
  const built = AppNodeBuilder.build(
    LayerNode.group([MCP.node, ToolRegistry.toolsNode, ToolRegistry.node, ApplicationTools.node, ToolOutputStore.node]),
    [[Config.node, config]],
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(built))
}

const server = () =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      mcp: new ConfigMCP.Info({
        servers: { mock: new ConfigMCP.Local({ type: "local", command: ["bun", fixture] }) },
      }),
    }),
  })

describe("MCP", () => {
  it.live("dedupes canonical tool names deterministically", () =>
    withMCP([server()], (registry) =>
      Effect.gen(function* () {
        const materialized = yield* registry.materialize()
        const names = materialized.definitions.map((definition) => definition.name)
        expect(names.filter((name) => name === "mcp__mock__a_b")).toHaveLength(1)
        // "a.b" sorts before "a_b", so the dot form is the one that wins.
        expect(materialized.definitions.find((definition) => definition.name === "mcp__mock__a_b")?.description).toBe(
          "Dot form",
        )
      }),
    ),
  )

  test("caps oversized image results", () => {
    const parts = MCP.resultContent({
      content: [{ type: "image", data: "A".repeat(MCP.MAX_RESULT_IMAGE_BASE64_BYTES + 1), mimeType: "image/png" }],
    })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(parts[0])).toContain("exceeds")
  })

  test("passes through image results within the cap", () => {
    const parts = MCP.resultContent({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })
    expect(parts).toEqual([{ type: "file", data: "AAAA", mime: "image/png" }])
  })

  it.live("registers an MCP tool and calls it", () =>
    withMCP([server()], (registry) =>
      Effect.gen(function* () {
        const materialized = yield* registry.materialize()
        expect(materialized.definitions.map((definition) => definition.name)).toContain("mcp__mock__echo")

        const settlement = yield* materialized.settle({
          sessionID: SessionV2.ID.make("ses_mcp"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_mcp"),
          call: { type: "tool-call", id: "call-mcp", name: "mcp__mock__echo", input: { text: "hi" } },
        })
        expect(JSON.stringify(settlement.result)).toContain("echo:hi")
      }),
    ),
  )
})
