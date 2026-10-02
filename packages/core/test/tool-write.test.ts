import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@miao/core/config"
import { ConfigLSP } from "@miao/core/config/lsp"
import { FileMutation } from "@miao/core/file-mutation"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FSUtil } from "@miao/core/fs-util"
import { Location } from "@miao/core/location"
import { LocationMutation } from "@miao/core/location-mutation"
import { PermissionV2 } from "@miao/core/permission"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { WriteTool } from "@miao/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  denyAction = undefined
}

const config = (lsp: ConfigLSP.Server) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ lsp: { mock: lsp } }),
          }),
        ]),
    }),
  )

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

// `lsp` wires one language server into the Location. Every case that omits it
// keeps the default empty LSP configuration, where `touchFile` finds no matching
// server and returns without starting anything.
const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  lsp?: ConfigLSP.Server,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const replacements: LayerNode.Replacements = [
    [FSUtil.node, filesystem],
    [Location.node, activeLocation],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
        ]),
        lsp ? replacements.concat([[Config.node, config(lsp)]]) : replacements,
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("registers and creates a relative file through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["write"])
            const settled = yield* settleTool(registry, call({ path: "src/new.txt", content: "created" }))
            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: src/new.txt" })
            expect(settled.output).toMatchObject({
              structured: {
                operation: "write",
                target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
                resource: "src/new.txt",
                existed: false,
                // The transcript renders a write summary from committed line counts,
                // so the tool reports the same patch shape the edit tool does.
                files: [{ file: "src/new.txt", additions: 1, deletions: 0, status: "added" }],
              },
              content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
              "created",
            )
            expect(String(assertions[0]?.metadata?.diff)).toContain("+created")
            expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["src/new.txt"], save: ["*"] }])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => settleTool(registry, call({ path: "existing.txt", content: "after" }))),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "text", value: "Wrote file successfully: existing.txt" })
              expect(settled.output?.structured).toMatchObject({ resource: "existing.txt", existed: true })
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
              expect(writes).toHaveLength(1)
              // The prompt shows the change against the current content, as V1 did.
              expect(String(assertions[0]?.metadata?.diff)).toContain("-before")
              expect(String(assertions[0]?.metadata?.diff)).toContain("+after")
              expect(assertions[0]?.metadata?.filepath).toBe(
                path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "existing.txt"),
              )
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const preserved = path.join(tmp.path, "preserved.txt")
        const deduplicated = path.join(tmp.path, "deduplicated.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(registry, call({ path: "preserved.txt", content: "after" }, "call-preserved"))
                yield* settleTool(
                  registry,
                  call({ path: "deduplicated.txt", content: "\uFEFFafter" }, "call-deduplicated"),
                )

                expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
                expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return withTool(tmp.path, (registry) => executeTool(registry, call({ path: target, content: "inside" }))).pipe(
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({ type: "text", value: "Created file successfully: absolute.txt" })
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return withTool(active.path, (registry) =>
          settleTool(registry, call({ path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalTarget = path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "external.txt")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              expect(assertions[0]).toMatchObject({
                resources: [
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ],
              })
              expect(assertions[1]).toMatchObject({ resources: [canonicalTarget.replaceAll("\\", "/")], save: ["*"] })
              expect(settled.output?.structured).toMatchObject({
                target: canonicalTarget,
                resource: canonicalTarget.replaceAll("\\", "/"),
                existed: false,
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(writes).toEqual([canonicalTarget])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to write ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: "denied.txt", content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value: "Unable to write denied.txt",
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  // A server that exits during `initialize` rejects its pending request. That
  // rejection used to reach the caller as a defect, and the `Effect.ignore` the
  // write leaf applies to `touchFile` cannot absorb a defect — so the tool
  // failed after its file had already landed on disk, and the runner failed
  // every other tool settled alongside it in the same batch.
  it.live("writes the file when its language server exits before initialize", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const content = "export const a = 1\nexport const b = 2\n"
          reset()
          const settled = yield* withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ path: "added.ts", content })),
            new ConfigLSP.Server({
              command: ["bun", path.resolve(import.meta.dir, "fixture/mock-lsp.ts"), "--exit-before-initialize"],
              extensions: [".ts"],
            }),
          )

          expect(settled.output?.structured).toMatchObject({
            operation: "write",
            existed: false,
            files: [{ status: "added", additions: 2, deletions: 0 }],
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "added.ts"), "utf8"))).toBe(content)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps the locked write schema, semantics docstring, and deferred UX TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/write.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["content", "path"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
