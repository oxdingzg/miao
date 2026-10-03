import { afterEach, describe, expect, mock } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Flag } from "@miao/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { Database } from "@miao/core/database/database"
import { Ripgrep } from "@miao/core/ripgrep"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.MIAO_EXPERIMENTAL_WORKSPACES
const appLayer = AppNodeBuilder.build(
  LayerNode.group([Project.node, SessionV2.node, Workspace.node, InstanceStore.node, Database.node, Ripgrep.node]),
  [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [SessionExecution.node, SessionExecution.noopLayer],
    [LocationServiceMap.node, locationServiceMapLayer],
  ],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function localAdapter(directory: string): WorkspaceAdapter {
  return {
    name: "Local Test",
    description: "Create a local test workspace",
    configure(info) {
      return {
        ...info,
        name: "local-test",
        directory,
      }
    },
    async create() {
      await mkdir(directory, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "local" as const,
        directory,
      }
    },
  }
}

afterEach(async () => {
  mock.restore()
  Flag.MIAO_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("workspace HttpApi", () => {
  it.live("serves the V2 workspace routes", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "v2-local", localAdapter(path.join(dir, ".v2-workspace")))

      const adapters = yield* request("/api/workspace/adapter", dir)
      expect(adapters.status).toBe(200)
      const adaptersBody = (yield* adapters.json) as { data: { type: string }[] }
      expect(adaptersBody.data).toContainEqual(expect.objectContaining({ type: "v2-local" }))

      const created = yield* request("/api/workspace", dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "v2-local", branch: null }),
      })
      expect(created.status).toBe(200)
      const createdBody = (yield* created.json) as { data: Workspace.Info }
      expect(createdBody.data).toMatchObject({ type: "v2-local", name: "local-test" })

      const listed = yield* request("/api/workspace", dir)
      expect(listed.status).toBe(200)
      const listedBody = (yield* listed.json) as { data: Workspace.Info[] }
      expect(listedBody.data).toMatchObject([{ id: createdBody.data.id }])

      const status = yield* request("/api/workspace/status", dir)
      expect(status.status).toBe(200)

      const synced = yield* request("/api/workspace/sync", dir, { method: "POST" })
      expect(synced.status).toBe(200)
      expect(yield* synced.json).toMatchObject({ data: true })

      const removed = yield* request(`/api/workspace/${createdBody.data.id}`, dir, { method: "DELETE" })
      expect(removed.status).toBe(200)
    }),
  )
})
