import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

// The V2 workspace control plane is core-backed now: it advertises the built-in
// worktree adapter and keeps local worktrees only. Creation and removal are
// covered against core worktrees in packages/core/test/project-worktree.test.ts.
describe("workspace HttpApi", () => {
  it.live("serves the built-in worktree adapter and an empty workspace list", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const adapters = yield* request("/api/workspace/adapter", dir)
      expect(adapters.status).toBe(200)
      const adaptersBody = (yield* adapters.json) as { data: { type: string; name: string }[] }
      expect(adaptersBody.data).toContainEqual(expect.objectContaining({ type: "worktree" }))

      const listed = yield* request("/api/workspace", dir)
      expect(listed.status).toBe(200)
      expect(((yield* listed.json) as { data: unknown[] }).data).toEqual([])

      const status = yield* request("/api/workspace/status", dir)
      expect(status.status).toBe(200)

      const synced = yield* request("/api/workspace/sync", dir, { method: "POST" })
      expect(synced.status).toBe(200)
      expect(yield* synced.json).toMatchObject({ data: true })
    }),
  )
})
