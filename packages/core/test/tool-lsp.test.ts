import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@miao/core/config"
import { ConfigLSP } from "@miao/core/config/lsp"
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
import { LspTool } from "@miao/core/tool/lsp"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_lsp_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
let reads = 0

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
  denyAction = undefined
  reads = 0
}

// Counts content reads so a test can prove that external-directory approval
// happens before a denied call ever reads the file.
const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFileStringSafe: (target) => Effect.sync(() => reads++).pipe(Effect.andThen(fs.readFileStringSafe(target))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const mockServer = (flags: ReadonlyArray<string> = []) =>
  new ConfigLSP.Server({
    command: ["bun", path.resolve(import.meta.dir, "fixture/mock-lsp.ts"), ...flags],
    extensions: [".mockts"],
  })

const config = (lsp: ConfigLSP.Server | Readonly<Record<string, ConfigLSP.Server>>) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ lsp: lsp instanceof ConfigLSP.Server ? { mock: lsp } : lsp }),
          }),
        ]),
    }),
  )

// `lsp` wires one or more language servers into the Location; without it the LSP
// service has no configured server and `hasClients` is false.
const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  lsp?: ConfigLSP.Server | Readonly<Record<string, ConfigLSP.Server>>,
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
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, LspTool.node]),
        lsp ? replacements.concat([[Config.node, config(lsp)]]) : replacements,
      ),
    ),
  )
}

const call = (input: typeof LspTool.Input.Type, id = "call-lsp") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "lsp", input },
})

const run = (registry: ToolRegistry.Interface, input: typeof LspTool.Input.Type, id?: string) =>
  executeTool(registry, call(input, id))

// Extracts model-facing text after asserting the settlement shape. Keeping this
// out of `toMatchObject` avoids a Bun matcher quirk with nested asymmetric
// matchers that corrupts a later expectation on the same object.
const textOf = (result: { readonly type: string; readonly value: unknown }) => {
  expect(result.type).toBe("text")
  if (typeof result.value !== "string") throw new Error("expected a text tool result")
  return result.value
}

const it = testEffect(Layer.empty)

describe("LspTool", () => {
  it.live("registers lsp and hides it when the lsp action is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      () => {
        reset()
        return withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("lsp")
            expect(yield* toolDefinitions(registry, [{ action: "lsp", resource: "*", effect: "deny" }])).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("dispatches every operation to a framed server and translates 1-based positions", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                Effect.gen(function* () {
                  const cursor = { filePath: "code.mockts", line: 3, character: 7 }
                  const operations = [
                    { input: { operation: "goToDefinition" as const, ...cursor }, marker: "MOCK_DEFINITION" },
                    { input: { operation: "findReferences" as const, ...cursor }, marker: "MOCK_REFERENCE" },
                    { input: { operation: "hover" as const, ...cursor }, marker: "MOCK_HOVER" },
                    { input: { operation: "documentSymbol" as const, ...cursor }, marker: "MOCK_DOCUMENT_SYMBOL" },
                    {
                      input: { operation: "workspaceSymbol" as const, ...cursor, query: "Thing" },
                      marker: "MOCK_WORKSPACE_Thing",
                    },
                    { input: { operation: "goToImplementation" as const, ...cursor }, marker: "MOCK_IMPLEMENTATION" },
                    { input: { operation: "prepareCallHierarchy" as const, ...cursor }, marker: "MOCK_CALL" },
                    { input: { operation: "incomingCalls" as const, ...cursor }, marker: "MOCK_CALLER" },
                    { input: { operation: "outgoingCalls" as const, ...cursor }, marker: "MOCK_CALLEE" },
                  ]
                  for (const item of operations) expect(textOf(yield* run(registry, item.input))).toContain(item.marker)

                  // The server echoes the request position, so the translated
                  // zero-based line and character prove the 1-based contract.
                  expect(textOf(yield* run(registry, { operation: "goToDefinition", ...cursor }))).toContain(
                    '"line": 2',
                  )
                  expect(textOf(yield* run(registry, { operation: "goToDefinition", ...cursor }))).toContain(
                    '"character": 6',
                  )
                }),
              mockServer(),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("passes workspaceSymbol the query and drops unsupported symbol kinds", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                Effect.gen(function* () {
                  yield* run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 })
                  const result = yield* run(registry, {
                    operation: "workspaceSymbol",
                    filePath: "code.mockts",
                    line: 1,
                    character: 1,
                    query: "Widget",
                  })
                  expect(textOf(result)).toContain("MOCK_WORKSPACE_Widget")
                  expect(textOf(result)).not.toContain("MOCK_WORKSPACE_IGNORED")
                }),
              mockServer(),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("records cursor metadata only for position operations", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                Effect.gen(function* () {
                  yield* run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 3, character: 7 })
                  yield* run(registry, { operation: "documentSymbol", filePath: "code.mockts", line: 3, character: 7 })
                  yield* run(registry, {
                    operation: "workspaceSymbol",
                    filePath: "code.mockts",
                    line: 3,
                    character: 7,
                    query: "X",
                  })
                  const canonical = path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "code.mockts")
                  expect(assertions.map((item) => item.action)).toEqual(["lsp", "lsp", "lsp"])
                  expect(assertions[0]).toMatchObject({ resources: ["*"], save: ["*"] })
                  expect(assertions[0]?.metadata).toEqual({
                    operation: "goToDefinition",
                    filePath: canonical,
                    line: 3,
                    character: 7,
                  })
                  expect(assertions[1]?.metadata).toEqual({ operation: "documentSymbol", filePath: canonical })
                  expect(assertions[2]?.metadata).toEqual({ operation: "workspaceSymbol" })
                }),
              mockServer(),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails clearly when no server matches the file type", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({ type: "error", value: "No LSP server available for this file type." })
              expect(assertions.map((item) => item.action)).toEqual(["lsp"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports a missing file after approval without starting a server", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(
          tmp.path,
          (registry) =>
            run(registry, { operation: "goToDefinition", filePath: "missing.mockts", line: 1, character: 1 }),
          mockServer(),
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({ type: "error", value: "File not found: missing.mockts" })
              expect(assertions.map((item) => item.action)).toEqual(["lsp"])
              expect(reads).toBe(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces a failure when the server exits before initialize", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              mockServer(["--exit-before-initialize"]),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: "No language server answered goToDefinition (tried mock).",
              })
              expect(reads).toBe(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces a failure when the server exits while answering a request", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              mockServer(["--exit-on-request"]),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: "No language server answered goToDefinition (tried mock).",
              })
              expect(reads).toBeGreaterThan(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // A server that never answers is bounded by the client request timeout, and
  // the resulting failure is surfaced instead of looking like an empty result.
  it.live(
    "surfaces a failure when the server hangs past the request timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
            Effect.andThen(
              withTool(
                tmp.path,
                (registry) =>
                  run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
                mockServer(["--hang-navigation"]),
              ),
            ),
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result).toEqual({
                  type: "error",
                  value: "No language server answered goToDefinition (tried mock).",
                })
                expect(reads).toBeGreaterThan(0)
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    15_000,
  )

  it.live("keeps a legitimate empty result distinct from an unavailable server", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              mockServer(["--empty"]),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({ type: "text", value: "No results found for goToDefinition" })
              expect(reads).toBeGreaterThan(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces a failure when the only matching server cannot start", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              new ConfigLSP.Server({
                command: ["miao-missing-lsp-binary-xyz"],
                extensions: [".mockts"],
              }),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: "No language server answered goToDefinition (tried mock).",
              })
              expect(reads).toBe(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps partial results when one of two matching servers answers", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              {
                mock: mockServer(),
                broken: new ConfigLSP.Server({
                  command: ["miao-missing-lsp-binary-xyz"],
                  extensions: [".mockts"],
                }),
              },
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(textOf(result)).toContain("MOCK_DEFINITION")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external path before reading it or requesting", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "code.mockts")
        return Effect.promise(() => fs.writeFile(target, "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              active.path,
              (registry) => run(registry, { operation: "goToDefinition", filePath: target, line: 3, character: 7 }),
              mockServer(),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(textOf(result)).toContain("MOCK_DEFINITION")
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "lsp"])
              expect(reads).toBeGreaterThan(0)
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

  it.live("does not read or request when external_directory is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "code.mockts")
        return Effect.promise(() => fs.writeFile(target, "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              active.path,
              (registry) => run(registry, { operation: "goToDefinition", filePath: target, line: 3, character: 7 }),
              mockServer(),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({ type: "error", value: `Unable to perform goToDefinition on ${target}` })
              expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
              expect(reads).toBe(0)
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

  it.live("does not read or request when lsp is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "lsp"
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "code.mockts"), "export const x = 1\n")).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              (registry) =>
                run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 1, character: 1 }),
              mockServer(),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({ type: "error", value: "Unable to perform goToDefinition on code.mockts" })
              expect(assertions.map((item) => item.action)).toEqual(["lsp"])
              expect(reads).toBe(0)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects non-positive model positions before touching the filesystem", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          run(registry, { operation: "goToDefinition", filePath: "code.mockts", line: 0, character: 1 }),
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
              expect(assertions).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
