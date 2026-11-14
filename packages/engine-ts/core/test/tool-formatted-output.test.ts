import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ConfigFormatter } from "@miao/core/config/formatter"
import { Config } from "@miao/core/config"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FileDiff } from "@miao/schema/file-diff"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { EditTool } from "@miao/core/tool/edit"
import { WriteTool } from "@miao/core/tool/write"
import { ApplyPatchTool } from "@miao/core/tool/apply-patch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const output = Schema.Struct({ files: Schema.Array(FileDiff.Info) })
const cases = [
  { name: "edit", input: { path: "target.txt", oldString: "before", newString: "unformatted" } },
  { name: "write", input: { path: "target.txt", content: "\uFEFFunformatted\r\nrest\r\n" } },
  {
    name: "apply_patch",
    input: { patchText: "*** Begin Patch\n*** Update File: target.txt\n@@\n-before\n+unformatted\n*** End Patch" },
  },
  {
    name: "apply_patch",
    input: {
      patchText:
        "*** Begin Patch\n*** Update File: target.txt\n*** Move to: moved.txt\n@@\n-before\n+unformatted\n*** End Patch",
    },
    destination: "moved.txt",
  },
] as const

describe("formatted tool output", () => {
  cases.forEach((scenario, index) => {
    it.live(`${scenario.name} ${index} reports final bytes and retains BOM/CRLF after a real formatter`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "target.txt"), "\uFEFFbefore\r\nrest\r\n"))
            const registry = yield* ToolRegistry.Service
            const settled = yield* settleTool(registry, {
              sessionID: SessionV2.ID.make("ses_formatted_test"),
              ...toolIdentity,
              call: { type: "tool-call", id: `call-format-${index}`, name: scenario.name, input: scenario.input },
            })
            expect(settled.result.type).not.toBe("error")
            const result = yield* Schema.decodeUnknownEffect(output)(settled.output?.structured)
            const target = "destination" in scenario ? scenario.destination : "target.txt"
            const content = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, target), "utf8"))
            expect(content).toBe("\uFEFFformatted\r\nrest\r\n")
            const file = result.files.find((file) => file.file === target)
            expect(file?.patch).toContain("+formatted")
            expect(file?.patch).not.toContain("+unformatted")
            if (scenario.name === "edit") expect(file).toMatchObject({ additions: 1, deletions: 1 })
            if ("destination" in scenario) {
              expect(result.files.find((file) => file.file === "target.txt")?.status).toBe("deleted")
              expect(file?.status).toBe("added")
            }
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(
                LayerNode.group([EditTool.node, WriteTool.node, ApplyPatchTool.node, ToolRegistry.node]),
                [
                  [
                    Location.node,
                    Layer.succeed(
                      Location.Service,
                      Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                    ),
                  ],
                  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
                  [
                    PermissionV2.node,
                    Layer.succeed(
                      PermissionV2.Service,
                      PermissionV2.Service.of({
                        assert: () => Effect.void,
                        ask: () => Effect.die("unused"),
                        reply: () => Effect.die("unused"),
                        get: () => Effect.die("unused"),
                        forSession: () => Effect.die("unused"),
                        list: () => Effect.die("unused"),
                      }),
                    ),
                  ],
                  [
                    Config.node,
                    Layer.succeed(
                      Config.Service,
                      Config.Service.of({
                        entries: () =>
                          Effect.succeed([
                            new Config.Document({
                              type: "document",
                              info: new Config.Info({
                                formatter: {
                                  "test-lf": new ConfigFormatter.Entry({
                                    command: [
                                      process.execPath,
                                      path.resolve(import.meta.dir, "fixture/format-to-lf.ts"),
                                      "$FILE",
                                    ],
                                    extensions: [".txt"],
                                  }),
                                },
                              }),
                            }),
                          ]),
                      }),
                    ),
                  ],
                ],
              ),
            ),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })
})
