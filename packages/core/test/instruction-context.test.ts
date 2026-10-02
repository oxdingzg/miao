import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { InstructionContext } from "@miao/core/instruction-context"
import { Location } from "@miao/core/location"
import { AbsolutePath } from "@miao/core/schema"
import { SystemContext } from "@miao/core/system-context"
import { SystemContextRegistry } from "@miao/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  home?: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
}) =>
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, InstructionContext.node]), [
    [Global.node, Global.layerWith({ config: input.config, ...(input.home ? { home: input.home } : {}) })],
    [Location.node, input.locationServiceLayer],
    ...(input.filesystemLayer ? [[FSUtil.node, input.filesystemLayer] as const] : []),
  ])

// Config discovery also scans upward; only intercept the instruction scan.
const instructionScan = (options: { targets: string[] }) => options.targets.includes("AGENTS.md")

describe("InstructionContext", () => {
  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const load = SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(yield* load)
          expect(initialized.baseline).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.baseline).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toMatchObject({
            _tag: "Updated",
            text: expect.stringContaining(`Instructions from: ${packageFile}\nchanged`),
          })

          yield* Effect.promise(() => fs.rm(packageFile))
          const partial = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(partial).toEqual({
            _tag: "Updated",
            text: [
              "These instructions replace all previously loaded ambient instructions.",
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
            snapshot: expect.any(Object),
          })

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({
            _tag: "Updated",
            text: "Previously loaded instructions no longer apply.",
            snapshot: {},
          })
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe(`Instructions from: ${file}\n`)
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                instructionScan(options)
                  ? Effect.fail(new FSUtil.FileSystemError({ method: "up" }))
                  : fs.up(options),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) => (instructionScan(options) ? Effect.succeed([file]) : fs.up(options)),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                instructionScan(options)
                  ? Effect.sync(() => {
                      observed = options
                      return []
                    })
                  : fs.up(options),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.MIAO_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.MIAO_DISABLE_PROJECT_CONFIG = "1"

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({
                    ...fs,
                    up: (options) =>
                      instructionScan(options) ? Effect.sync(() => ((scanned = true), [])) : fs.up(options),
                  })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.MIAO_DISABLE_PROJECT_CONFIG
            else process.env.MIAO_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({
                    ...fs,
                    up: (options) =>
                      instructionScan(options) ? Effect.sync(() => ((scanned = true), [])) : fs.up(options),
                  })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  describe("sources", () => {
    const withTmp = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(Effect.flatMap((tmp) => body(tmp.path)))

    const write = (files: Record<string, string>) =>
      Effect.promise(() =>
        Promise.all(
          Object.entries(files).map(async ([file, content]) => {
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, content)
          }),
        ),
      )

    const layerFor = (root: string, directory = path.join(root, "project")) =>
      instructionLayer({
        config: path.join(root, "global"),
        home: path.join(root, "home"),
        locationServiceLayer: Layer.succeed(
          Location.Service,
          Location.Service.of(
            location(
              { directory: AbsolutePath.make(directory) },
              { projectDirectory: AbsolutePath.make(path.join(root, "project")) },
            ),
          ),
        ),
      })

    const baseline = (layer: ReturnType<typeof layerFor>) =>
      SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.flatMap(SystemContext.initialize),
        Effect.map((initialized) => initialized.baseline),
        Effect.provide(layer),
      )

    const withEnv = <A, E, R>(key: string, value: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env[key]
          process.env[key] = value
          return previous
        }),
        () => effect,
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[key]
            else process.env[key] = previous
          }),
      )

    it.live("falls back to ~/.claude/CLAUDE.md only when the global AGENTS.md is missing", () =>
      withTmp((root) =>
        Effect.gen(function* () {
          const claude = path.join(root, "home", ".claude", "CLAUDE.md")
          const agents = path.join(root, "global", "AGENTS.md")
          yield* write({ [claude]: "claude global", [path.join(root, "project", ".keep")]: "" })
          expect(yield* baseline(layerFor(root))).toBe(`Instructions from: ${claude}\nclaude global`)

          yield* write({ [agents]: "miao global" })
          expect(yield* baseline(layerFor(root))).toBe(`Instructions from: ${agents}\nmiao global`)
        }),
      ),
    )

    it.live("uses only the first project file name found on the upward path", () =>
      withTmp((root) =>
        Effect.gen(function* () {
          const project = path.join(root, "project")
          const directory = path.join(project, "packages", "app")
          yield* write({
            [path.join(directory, "CLAUDE.md")]: "near claude",
            [path.join(directory, "CONTEXT.md")]: "near context",
            [path.join(project, "AGENTS.md")]: "root agents",
          })
          // AGENTS.md wins over a nearer CLAUDE.md, as in V1.
          expect(yield* baseline(layerFor(root, directory))).toBe(
            `Instructions from: ${path.join(project, "AGENTS.md")}\nroot agents`,
          )

          yield* Effect.promise(() => fs.rm(path.join(project, "AGENTS.md")))
          yield* write({ [path.join(project, "CLAUDE.md")]: "root claude" })
          expect(yield* baseline(layerFor(root, directory))).toBe(
            [
              `Instructions from: ${path.join(directory, "CLAUDE.md")}\nnear claude`,
              `Instructions from: ${path.join(project, "CLAUDE.md")}\nroot claude`,
            ].join("\n\n"),
          )

          // MIAO_DISABLE_CLAUDE_CODE_PROMPT skips CLAUDE.md and falls through to CONTEXT.md.
          expect(yield* withEnv("MIAO_DISABLE_CLAUDE_CODE_PROMPT", "1", baseline(layerFor(root, directory)))).toBe(
            `Instructions from: ${path.join(directory, "CONTEXT.md")}\nnear context`,
          )
        }),
      ),
    )

    it.live("appends configured globs and URLs after discovered files without duplicates", () =>
      withTmp((root) =>
        Effect.gen(function* () {
          const project = path.join(root, "project")
          let requests = 0
          const server = Bun.serve({
            port: 0,
            fetch: (request) => {
              requests++
              return new URL(request.url).pathname === "/ok"
                ? new Response("remote rules")
                : new Response("missing", { status: 404 })
            },
          })
          yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
          const ok = `http://127.0.0.1:${server.port}/ok`
          const missing = `http://127.0.0.1:${server.port}/missing`
          const absolute = path.join(root, "shared", "team.md")
          yield* write({
            [path.join(project, "AGENTS.md")]: "project",
            [path.join(project, "docs", "a.md")]: "doc a",
            [path.join(project, "docs", "b.md")]: "doc b",
            [path.join(root, "home", "notes", "me.md")]: "home note",
            [absolute]: "team",
            [path.join(root, "global", "miao.json")]: JSON.stringify({
              instructions: [missing, "docs/*.md", "AGENTS.md", absolute, "~/notes/me.md", ok],
            }),
          })

          const expected = [
            `Instructions from: ${path.join(project, "AGENTS.md")}\nproject`,
            `Instructions from: ${path.join(project, "docs", "a.md")}\ndoc a`,
            `Instructions from: ${path.join(project, "docs", "b.md")}\ndoc b`,
            `Instructions from: ${absolute}\nteam`,
            `Instructions from: ${path.join(root, "home", "notes", "me.md")}\nhome note`,
            `Instructions from: ${ok}\nremote rules`,
          ].join("\n\n")
          yield* Effect.gen(function* () {
            const registry = yield* SystemContextRegistry.Service
            expect((yield* SystemContext.initialize(yield* registry.load())).baseline).toBe(expected)
            const fetched = requests
            // Every provider turn re-observes context; cached URLs keep the prefix stable without refetching.
            expect((yield* SystemContext.initialize(yield* registry.load())).baseline).toBe(expected)
            expect(requests).toBe(fetched)
          }).pipe(Effect.provide(layerFor(root)))
        }),
      ).pipe(Effect.scoped),
    )

    it.live("attaches nested instruction files once per session and skips ambient ones", () =>
      withTmp((root) =>
        Effect.gen(function* () {
          const project = path.join(root, "project")
          const nested = path.join(project, "packages", "app", "src")
          const appAgents = path.join(project, "packages", "app", "AGENTS.md")
          const srcClaude = path.join(nested, "CLAUDE.md")
          const file = path.join(nested, "index.ts")
          yield* write({
            [path.join(project, "AGENTS.md")]: "ambient",
            [appAgents]: "app rules",
            [srcClaude]: "src rules",
            [file]: "export {}",
          })

          yield* Effect.gen(function* () {
            const instructions = yield* InstructionContext.Service
            expect(yield* instructions.nearby({ sessionID: "ses_a", path: file })).toEqual([
              new InstructionContext.File({ path: srcClaude, content: "src rules" }),
              new InstructionContext.File({ path: appAgents, content: "app rules" }),
            ])
            expect(yield* instructions.nearby({ sessionID: "ses_a", path: file })).toEqual([])
            expect(yield* instructions.nearby({ sessionID: "ses_b", path: srcClaude })).toEqual([
              new InstructionContext.File({ path: appAgents, content: "app rules" }),
            ])
          }).pipe(Effect.provide(layerFor(root)))
        }),
      ),
    )
  })
})
