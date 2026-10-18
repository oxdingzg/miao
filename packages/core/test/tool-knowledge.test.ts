import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { KnowledgeTool } from "@miao/core/tool/knowledge"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const exists = (target: string) =>
  fs.access(target).then(
    () => true,
    () => false,
  )
const it = testEffect(Layer.empty)
const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  denied?: string,
) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KnowledgeTool.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        [
          PermissionV2.node,
          Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                input.action === denied ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          ),
        ],
      ]),
    ),
  )
const call = (input: typeof KnowledgeTool.Input.Type, session = "ses_knowledge_test") => ({
  sessionID: SessionV2.ID.make(session),
  ...toolIdentity,
  call: { type: "tool-call" as const, name: "knowledge", id: "knowledge-call", input },
})
const invoke = (registry: ToolRegistry.Interface, input: typeof KnowledgeTool.Input.Type, session?: string) =>
  settleTool(registry, call(input, session)).pipe(
    Effect.map((settled) => {
      expect(settled.result.type).toBe("text")
      if (settled.result.type !== "text" || typeof settled.result.value !== "string")
        throw new Error("Expected knowledge text")
      return JSON.parse(settled.result.value)
    }),
  )

it.live("persists exact-source indexes across Sessions and invalidates edited sources", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.ts"), "export function actual() {}\n"))
          expect((yield* invoke(registry, { op: "list" })).store_sha256).toBeNull()
          expect(yield* Effect.promise(() => exists(path.join(tmp.path, ".miao")))).toBe(false)
          const indexed = yield* invoke(registry, {
            op: "index_file",
            id: "source",
            path: "source.ts",
            expected_revision: 0,
            expected_store_sha256: null,
          })
          expect(indexed.applied).toBe(true)
          const note = yield* invoke(registry, { op: "get", id: "source" }, "ses_other")
          expect(note.source_state).toBe("current")
          expect(JSON.parse(note.body).symbol_candidates).toEqual([{ line: 1, kind: "function", name: "actual" }])
          const document = JSON.parse(
            yield* Effect.promise(() => fs.readFile(path.join(tmp.path, KnowledgeTool.storePath), "utf8")),
          )
          expect(document.notes.source.location).toBe(hash(yield* Effect.promise(() => fs.realpath(tmp.path))))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.ts"), "export function changed() {}\n"))
          expect((yield* invoke(registry, { op: "get", id: "source" })).body).toBeNull()
          const stale = yield* invoke(registry, { op: "get", id: "source", include_stale: true })
          expect(stale.source_state).toBe("source_changed")
          expect(stale.body).toContain("actual")
          expect(
            (yield* invoke(registry, {
              op: "index_file",
              id: "source",
              path: "source.ts",
              expected_revision: indexed.revision,
              expected_store_sha256: indexed.store_sha256,
            })).applied,
          ).toBe(true)
          expect((yield* invoke(registry, { op: "get", id: "source" })).source_state).toBe("current")
        }),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("preserves manual edits, malformed stores and stale double-CAS requests", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          const put = {
            op: "put" as const,
            id: "style",
            kind: "preference" as const,
            title: "Style",
            body: "Prefer short names",
            expected_revision: 0,
            expected_store_sha256: null,
          }
          const created = yield* invoke(registry, put)
          expect((yield* invoke(registry, { op: "get", id: "style" })).source_state).toBe("unverified")
          expect((yield* invoke(registry, { op: "get", id: "style" })).body).toBeNull()
          expect((yield* invoke(registry, put)).applied).toBe(false)
          const target = path.join(tmp.path, KnowledgeTool.storePath)
          const original = yield* Effect.promise(() => fs.readFile(target, "utf8"))
          yield* Effect.promise(() => fs.writeFile(target, original + "\n"))
          expect(
            (yield* invoke(registry, {
              ...put,
              expected_revision: created.revision,
              expected_store_sha256: created.store_sha256,
            })).applied,
          ).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(original + "\n")
          yield* Effect.promise(() => fs.writeFile(target, "{manual unfinished"))
          expect((yield* settleTool(registry, call(put))).result.type).toBe("error")
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("{manual unfinished")
        }),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("withholds source-restricted content even when include_stale requests it", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "secret.ts"), "export class Secret {}"))
        yield* withTool(tmp.path, (registry) =>
          invoke(registry, {
            op: "index_file",
            id: "secret",
            path: "secret.ts",
            expected_revision: 0,
            expected_store_sha256: null,
          }),
        )
        yield* withTool(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              const note = yield* invoke(registry, { op: "get", id: "secret", include_stale: true })
              expect(note.source_state).toBe("restricted")
              expect(note.body).toBeUndefined()
              expect((yield* invoke(registry, { op: "list" })).notes).toEqual([])
            }),
          "read",
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("requires edit authority and does not create a denied store", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(
        tmp.path,
        (registry) =>
          Effect.gen(function* () {
            const input = {
              op: "put" as const,
              id: "style",
              kind: "preference" as const,
              title: "Style",
              body: "short",
              expected_revision: 0,
              expected_store_sha256: null,
            }
            expect((yield* settleTool(registry, call(input))).result.type).toBe("error")
            expect(yield* Effect.promise(() => exists(path.join(tmp.path, KnowledgeTool.storePath)))).toBe(false)
          }),
        "edit",
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("treats prototype-looking IDs as ordinary notes and never reuses revisions after deletion", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          const put = {
            op: "put" as const,
            id: "__proto__",
            kind: "preference" as const,
            title: "Style",
            body: "short",
            expected_revision: 0,
            expected_store_sha256: null,
          }
          const created = yield* invoke(registry, put)
          expect(created.applied).toBe(true)
          expect((yield* invoke(registry, { op: "get", id: "__proto__", include_stale: true })).body).toBe("short")
          const deleted = yield* invoke(registry, {
            op: "delete",
            id: "__proto__",
            expected_revision: created.revision,
            expected_store_sha256: created.store_sha256,
          })
          expect(deleted.deleted).toBe(true)
          const recreated = yield* invoke(registry, { ...put, expected_store_sha256: deleted.store_sha256 })
          expect(recreated.revision).toBeGreaterThan(deleted.revision)
          expect(
            (yield* invoke(registry, {
              op: "put",
              id: "constructor",
              kind: "preference",
              title: "Other",
              body: "safe",
              expected_revision: 0,
              expected_store_sha256: recreated.store_sha256,
            })).applied,
          ).toBe(true)
        }),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
