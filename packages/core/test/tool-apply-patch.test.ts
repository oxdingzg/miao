import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import { Config } from "@miao/core/config"
import { ConfigLSP } from "@miao/core/config/lsp"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FileMutation } from "@miao/core/file-mutation"
import { FSUtil } from "@miao/core/fs-util"
import { Location } from "@miao/core/location"
import { LocationMutation } from "@miao/core/location-mutation"
import { PermissionV2 } from "@miao/core/permission"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { ApplyPatchTool } from "@miao/core/tool/apply-patch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_apply_patch_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
let failRemoveTarget: string | undefined
let failMoveRemoveTarget: string | undefined
let moveWriteTarget: string | undefined
let afterMoveWrite: Effect.Effect<void> = Effect.void
let readsBeforeExternalApproval = 0
let externalApproved = false
let blockRemoveTarget: string | undefined
let removeStarted: Deferred.Deferred<void> | undefined
let releaseRemove: Deferred.Deferred<void> | undefined
let afterEditApproval = (): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
        if (input.action === "external_directory") externalApproved = true
      }).pipe(
        Effect.andThen(input.action === "edit" ? Effect.suspend(afterEditApproval) : Effect.void),
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
  denyAction = undefined
  failRemoveTarget = undefined
  failMoveRemoveTarget = undefined
  moveWriteTarget = undefined
  afterMoveWrite = Effect.void
  readsBeforeExternalApproval = 0
  externalApproved = false
  blockRemoveTarget = undefined
  removeStarted = undefined
  releaseRemove = undefined
  afterEditApproval = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeFile: (target, content, options) =>
        fs
          .writeFile(target, content, options)
          .pipe(
            Effect.andThen(
              Effect.suspend(() => (path.basename(target) === moveWriteTarget ? afterMoveWrite : Effect.void)),
            ),
          ),
      writeFileString: (target, content, options) =>
        fs
          .writeFileString(target, content, options)
          .pipe(
            Effect.andThen(
              Effect.suspend(() => (path.basename(target) === moveWriteTarget ? afterMoveWrite : Effect.void)),
            ),
          ),
      readFile: (target) =>
        Effect.sync(() => {
          if (!externalApproved) readsBeforeExternalApproval++
        }).pipe(Effect.andThen(fs.readFile(target))),
      remove: (target, options) => {
        if (failMoveRemoveTarget && path.basename(target) === failMoveRemoveTarget)
          return Effect.fail(
            systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              pathOrDescriptor: target,
              cause: new Error("forced move removal failure"),
            }),
          )
        if (failRemoveTarget && path.basename(target) === failRemoveTarget) return Effect.die("forced remove failure")
        if (blockRemoveTarget && path.basename(target) === blockRemoveTarget && removeStarted && releaseRemove)
          return Deferred.succeed(removeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRemove)),
            Effect.andThen(fs.remove(target, options)),
          )
        return fs.remove(target, options)
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const config = (lsp: ConfigLSP.Server) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ lsp: { mock: lsp } }) })]),
    }),
  )

// `lsp` wires one language server into the Location; without it touchFile finds no server.
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
          ApplyPatchTool.node,
        ]),
        lsp ? replacements.concat([[Config.node, config(lsp)]]) : replacements,
      ),
    ),
  )
}

const call = (patchText: string, id = "call-apply-patch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "apply_patch", input: { patchText } },
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )
const it = testEffect(Layer.empty)

describe("ApplyPatchTool", () => {
  it.live("registers and sequentially applies add, update, and delete hunks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const update = path.join(tmp.path, "update.txt")
        const remove = path.join(tmp.path, "remove.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(update, "before\n"), fs.writeFile(remove, "remove\n")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["apply_patch"])
                const settled = yield* settleTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
                  ),
                )
                expect(settled.result).toEqual({
                  type: "text",
                  value: "Applied patch sequentially:\nA nested/new.txt\nM update.txt\nD remove.txt",
                })
                expect(settled.output?.structured).toMatchObject({
                  applied: [
                    { type: "add", resource: "nested/new.txt" },
                    { type: "update", resource: "update.txt" },
                    { type: "delete", resource: "remove.txt" },
                  ],
                  files: [
                    {
                      file: "nested/new.txt",
                      status: "added",
                      additions: 1,
                      deletions: 0,
                      patch: expect.stringContaining("+created"),
                    },
                    {
                      file: "update.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                    {
                      file: "remove.txt",
                      status: "deleted",
                      additions: 0,
                      deletions: 1,
                      patch: expect.stringContaining("-remove"),
                    },
                  ],
                })
                // The prompt shows every file's change before any of them is written.
                const diff = String(assertions[0]?.metadata?.diff)
                expect(diff).toContain("+created")
                expect(diff).toContain("-before\n+after")
                expect(diff).toContain("-remove")
                expect(assertions).toMatchObject([
                  {
                    sessionID,
                    action: "edit",
                    resources: ["nested/new.txt", "update.txt", "remove.txt"],
                    save: ["*"],
                    metadata: {
                      filepath: "nested/new.txt, update.txt, remove.txt",
                      files: [{ file: "nested/new.txt" }, { file: "update.txt" }, { file: "remove.txt" }],
                    },
                  },
                ])
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "nested/new.txt"), "utf8"))).toBe(
                  "created\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe("after\n")
                expect(yield* exists(remove)).toBe(false)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports language server errors in the files the patch added or updated", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "update.ts"), "export const a = 1\n"),
              fs.writeFile(path.join(tmp.path, "remove.ts"), "export const b = 1\n"),
            ]),
          )
          const settled = yield* withTool(
            tmp.path,
            (registry) =>
              settleTool(
                registry,
                call(
                  "*** Begin Patch\n*** Add File: added.ts\n+export const c = 1\n*** Update File: update.ts\n@@\n-export const a = 1\n+export const a = 2\n*** Delete File: remove.ts\n*** End Patch",
                ),
              ),
            new ConfigLSP.Server({
              command: ["bun", path.resolve(import.meta.dir, "fixture/mock-lsp.ts")],
              extensions: [".ts"],
            }),
          )
          const diagnostics = String((settled.output?.structured as ApplyPatchTool.Output | undefined)?.diagnostics)
          expect(diagnostics).toContain('<diagnostics file="added.ts">')
          expect(diagnostics).toContain('<diagnostics file="update.ts">')
          expect(diagnostics).toContain("MOCK_ERROR")
          expect(diagnostics).not.toContain("remove.ts")
          expect(settled.result).toMatchObject({
            type: "text",
            value: expect.stringContaining("LSP errors detected in the patched files, please fix:"),
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("moves and edits a file after approving both endpoints", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        const target = path.join(tmp.path, "nested/moved.txt")
        return Effect.promise(() => fs.writeFile(source, "\ufeffbefore\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(source, 0o755))
                const settled = yield* settleTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: old.txt\n*** Move to: nested/moved.txt\n@@\n-before\n+after\n*** End Patch",
                  ),
                )
                expect(settled.result).toEqual({
                  type: "text",
                  value: "Applied patch sequentially:\nA created.txt\nA nested/moved.txt\nD old.txt",
                })
                expect(yield* exists(source)).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\ufeffafter\n")
                if (process.platform !== "win32")
                  expect((yield* Effect.promise(() => fs.stat(target))).mode & 0o777).toBe(0o755)
                expect(assertions[0]?.resources).toEqual(["created.txt", "old.txt", "nested/moved.txt"])
                expect(settled.output?.structured).toMatchObject({
                  files: [
                    { file: "created.txt", status: "added" },
                    { file: "old.txt", status: "deleted" },
                    { file: "nested/moved.txt", status: "added" },
                  ],
                })
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  ;[Buffer.from("\ufefffirst\r\nlast"), Buffer.from([0, 255, 254, 10, 13])].forEach((bytes, index) => {
    it.live(`preserves every byte for a pure move ${index}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const source = path.join(tmp.path, "old.bin")
          const target = path.join(tmp.path, "new.bin")
          return Effect.promise(() => fs.writeFile(source, bytes)).pipe(
            Effect.andThen(
              withTool(tmp.path, (registry) =>
                Effect.gen(function* () {
                  expect(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Update File: old.bin\n*** Move to: new.bin\n*** End Patch"),
                    ),
                  ).toEqual({ type: "text", value: "Applied patch sequentially:\nA new.bin\nD old.bin" })
                  expect(yield* exists(source)).toBe(false)
                  expect(yield* Effect.promise(() => fs.readFile(target))).toEqual(bytes)
                }),
              ),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  it.live("does not overwrite an existing move destination or apply earlier hunks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(tmp.path, "old.txt"), "source\n"),
            fs.writeFile(path.join(tmp.path, "new.txt"), "winner\n"),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const result = yield* executeTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch",
                  ),
                )
                expect(result).toMatchObject({
                  type: "error",
                  value: expect.stringContaining("destination already exists"),
                })
                expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "old.txt"), "utf8"))).toBe(
                  "source\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "new.txt"), "utf8"))).toBe(
                  "winner\n",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("same-path moves update contents without deleting the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "same.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Update File: same.txt\n*** Move to: ./same.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  ),
                ).toEqual({ type: "text", value: "Applied patch sequentially:\nM same.txt" })
                expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("checks a moved source again after edit approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        afterEditApproval = () => Effect.promise(() => fs.writeFile(source, "manual edit\n"))
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch"),
                  ),
                ).toEqual({ type: "error", value: "Unable to apply patch at old.txt" })
                expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("manual edit\n")
                expect(yield* exists(path.join(tmp.path, "new.txt"))).toBe(false)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports a destination created before source removal failed", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        failMoveRemoveTarget = "old.txt"
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch"),
                  ),
                ).toMatchObject({ type: "error", value: expect.stringContaining("Destination was created") })
                expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("before\n")
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "new.txt"), "utf8"))).toBe(
                  "before\n",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an external move destination before reading even an internal source", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const source = path.join(active.path, "old.txt")
        const target = path.join(outside.path, "new.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: old.txt\n*** Move to: ${target}\n*** End Patch`),
                  ),
                ).toMatchObject({ type: "text" })
                expect(readsBeforeExternalApproval).toBe(0)
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "edit"])
                expect(assertions[1]?.resources).toEqual(["old.txt", target.replaceAll("\\", "/")])
                expect(yield* exists(source)).toBe(false)
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )

  it.live("refuses source deletion after an external edit during destination creation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        moveWriteTarget = "new.txt"
        afterMoveWrite = Effect.promise(() => fs.writeFile(source, "external edit\n"))
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch"),
                  ),
                ).toMatchObject({ type: "error", value: expect.stringContaining("Destination was created") })
                expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("external edit\n")
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "new.txt"), "utf8"))).toBe(
                  "before\n",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not read or mutate when the external move permission is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const source = path.join(active.path, "old.txt")
        const target = path.join(outside.path, "new.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: old.txt\n*** Move to: ${target}\n*** End Patch`),
                  ),
                ).toMatchObject({ type: "error" })
                expect(readsBeforeExternalApproval).toBe(0)
                expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
                expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("before\n")
                expect(yield* exists(target)).toBe(false)
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() => Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()])),
    ),
  )

  it.live("rejects conflicting move endpoints before committing the batch", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(tmp.path, "a.txt"), "a\n"),
            fs.writeFile(path.join(tmp.path, "b.txt"), "b\n"),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Update File: a.txt\n*** Move to: new.txt\n*** Update File: b.txt\n*** Move to: new.txt\n*** End Patch",
                    ),
                  ),
                ).toMatchObject({ type: "error" })
                expect(yield* exists(path.join(tmp.path, "new.txt"))).toBe(false)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "a.txt"), "utf8"))).toBe("a\n")
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "b.txt"), "utf8"))).toBe("b\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an external directory before reading external update content, then the batch with its diff", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`),
                  ),
                ).toMatchObject({ type: "text" })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(readsBeforeExternalApproval).toBe(0)
                expect(assertions[1]?.metadata?.diff).toContain("-before\n+after")
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves one external directory scope for multiple files under the same parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const first = path.join(outside.path, "first.txt")
        const second = path.join(outside.path, "second.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(first, "before\n"), fs.writeFile(second, "before\n")]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      `*** Begin Patch\n*** Update File: ${first}\n@@\n-before\n+after\n*** Update File: ${second}\n@@\n-before\n+after\n*** End Patch`,
                    ),
                  ),
                ).toMatchObject({ type: "text" })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(assertions[0]?.resources).toEqual([
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ])
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("rejects invalid later update before applying an earlier add", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch",
                ),
              ),
            ).toEqual({ type: "error", value: "Unable to apply patch at missing.txt" })
            expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
            // The failure is reported only after edit approval, which then carries no diff.
            expect(assertions).toMatchObject([{ action: "edit", metadata: { filepath: "created.txt, missing.txt" } }])
            expect(assertions[0]?.metadata?.diff).toBeUndefined()
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("denied edit does not disclose whether the patch context matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "secret.txt"), "secret\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const patch = (line: string) =>
                  call(`*** Begin Patch\n*** Update File: secret.txt\n@@\n-${line}\n+replacement\n*** End Patch`)
                const matching = yield* executeTool(registry, patch("secret"))
                const missing = yield* executeTool(registry, patch("not present"))
                expect(matching).toEqual({ type: "error", value: "Unable to apply patch at patch" })
                expect(missing).toEqual(matching)
                expect(assertions.map((input) => input.action)).toEqual(["edit", "edit"])
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "secret.txt"), "utf8"))).toBe(
                  "secret\n",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects add hunks targeting an existing file without replacing it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "existing.txt")
        return Effect.promise(() => fs.writeFile(target, "sentinel\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch"),
                  ),
                ).toEqual({ type: "error", value: "Unable to apply patch at existing.txt" })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("sentinel\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an add target that appears during permission approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "appeared.txt")
        afterEditApproval = () => Effect.promise(() => fs.writeFile(target, "winner\n")).pipe(Effect.orDie)
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Add File: appeared.txt\n+replacement\n*** End Patch"),
              ),
            ).toEqual({ type: "error", value: "Unable to apply patch at appeared.txt" })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("winner\n")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves a later commit defect after earlier sequential applications", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        failRemoveTarget = path.basename(second)
        return Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")])).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  Exit.isFailure(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
                    ).pipe(Effect.exit),
                  ),
                ).toBe(true)
                expect(yield* exists(first)).toBe(false)
                expect(yield* exists(second)).toBe(true)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("finishes the sequential commit phase when interrupted after the first mutation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        blockRemoveTarget = path.basename(second)
        return Effect.gen(function* () {
          removeStarted = yield* Deferred.make<void>()
          releaseRemove = yield* Deferred.make<void>()
          yield* Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]))
          yield* withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const run = yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
              ).pipe(Effect.forkChild)
              yield* Deferred.await(removeStarted!)
              const interrupt = yield* Fiber.interrupt(run).pipe(Effect.forkChild)
              yield* Deferred.succeed(releaseRemove!, undefined)
              yield* Fiber.join(interrupt)
              expect(yield* exists(first)).toBe(false)
              expect(yield* exists(second)).toBe(false)
            }),
          )
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
