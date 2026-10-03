import { afterEach, describe, expect, mock } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Flag } from "@miao/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@miao/core/workspace"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspacePaths } from "../../src/server/routes/instance/httpapi/groups/workspace"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { AbsolutePath } from "@miao/core/schema"
import { Database } from "@miao/core/database/database"
import { Ripgrep } from "@miao/core/ripgrep"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
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

function requestDefault(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function requestServer(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, { ...init, headers })))
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

function listedAdapter(directory: string, type: string): WorkspaceAdapter {
  return {
    name: "Listed Test",
    description: "List a local test workspace",
    configure(info) {
      return { ...info, name: "unused", directory }
    },
    async create() {},
    async remove() {},
    list(context) {
      return [
        {
          type,
          name: "listed-test",
          branch: "listed/main",
          directory,
          extra: { listed: true },
          projectID: context?.instance?.project.id ?? missingAdapterContext(),
        },
      ]
    },
    target() {
      return {
        type: "local" as const,
        directory,
      }
    },
  }
}

function missingAdapterContext(): never {
  throw new Error("missing workspace adapter context")
}

function remoteAdapter(directory: string, url: string, headers?: HeadersInit): WorkspaceAdapter {
  return {
    name: "Remote Test",
    description: "Create a remote test workspace",
    configure(info) {
      return {
        ...info,
        name: "remote-test",
        directory,
      }
    },
    async create() {
      await mkdir(directory, { recursive: true })
    },
    async remove() {},
    target() {
      return {
        type: "remote" as const,
        url,
        headers,
      }
    },
  }
}

type ProxiedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function listenRemoteHttp(handler: (request: ProxiedRequest) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      return handler({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
      })
    },
  })
}

function eventStreamResponse() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"payload":{"type":"server.connected","properties":{}}}\n\n'),
        )
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  )
}

afterEach(async () => {
  mock.restore()
  Flag.MIAO_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("workspace HttpApi", () => {
  it.live("serves read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const [adapters, workspaces, status] = yield* Effect.all([
        request(WorkspacePaths.adapters, dir),
        request(WorkspacePaths.list, dir),
        request(WorkspacePaths.status, dir),
      ])

      expect(adapters.status).toBe(200)
      expect(yield* adapters.json).toContainEqual({
        type: "worktree",
        name: "Worktree",
        description: "Create a git worktree",
      })

      expect(workspaces.status).toBe(200)
      expect(yield* workspaces.json).toEqual([])

      expect(status.status).toBe(200)
      expect(yield* status.json).toEqual([])
    }),
  )

  it.live("serves mutation endpoints", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-test", localAdapter(path.join(dir, ".workspace")))

      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-test", branch: null }),
      })
      expect(created.status).toBe(200)
      const workspace = (yield* created.json) as Workspace.Info
      expect(workspace).toMatchObject({ type: "local-test", name: "local-test" })

      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
      const warped = yield* request(WorkspacePaths.warp, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workspace.id, sessionID: session.id }),
      })
      expect(warped.status).toBe(204)

      const removed = yield* request(WorkspacePaths.remove.replace(":id", workspace.id), dir, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(yield* removed.json).toMatchObject({ id: workspace.id })

      const listed = yield* request(WorkspacePaths.list, dir)
      expect(listed.status).toBe(200)
      expect(yield* listed.json).toEqual([])
    }),
  )

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

  it.live("serves list sync endpoint", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      const type = `listed-${Math.random().toString(36).slice(2)}`
      registerAdapter(project.project.id, type, listedAdapter(path.join(dir, ".listed"), type))

      const response = yield* request(WorkspacePaths.syncList, dir, { method: "POST" })

      expect(response.status).toBe(204)
      const listed = yield* request(WorkspacePaths.list, dir)
      expect(yield* listed.json).toMatchObject([
        {
          type,
          name: "listed-test",
          branch: "listed/main",
          directory: path.join(dir, ".listed"),
          extra: { listed: true },
        },
      ])
    }),
  )

  it.live("returns a declared not found error when warping into a missing workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
      const workspaceID = WorkspaceV2.ID.ascending("wrk_missing_warp")

      const response = yield* request(WorkspacePaths.warp, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workspaceID, sessionID: session.id }),
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        name: "NotFoundError",
        data: { message: `Workspace not found: ${workspaceID}` },
      })
    }),
  )

  it.live("creates workspace with the TUI payload shape", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-test", localAdapter(path.join(dir, ".workspace")))

      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-test", branch: null }),
      })

      expect(created.status).toBe(200)
      expect((yield* created.json) as Workspace.Info).toMatchObject({
        type: "local-test",
        name: "local-test",
      })
    }),
  )

  it.live("creates a real git worktree workspace via the builtin adapter", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })

      const created = yield* requestServer(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "worktree", branch: null }),
      })

      const body = yield* Effect.promise(() => created.text())
      expect({ status: created.status, body }).toMatchObject({ status: 200 })
      const workspace = JSON.parse(body) as Workspace.Info
      expect(workspace).toMatchObject({ type: "worktree" })
    }),
  )

  it.live("routes local workspace requests through the workspace target directory", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const workspaceDir = path.join(dir, ".workspace-local")
      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(project.project.id, "local-target", localAdapter(workspaceDir))
      const created = yield* request(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "local-target", branch: null }),
      })
      const workspace = (yield* created.json) as Workspace.Info

      const url = new URL(`http://localhost${InstancePaths.path}`)
      url.searchParams.set("workspace", workspace.id)

      const response = yield* request(url.toString(), dir)

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ directory: workspaceDir })
      yield* request(WorkspacePaths.remove.replace(":id", workspace.id), dir, { method: "DELETE" })
    }),
  )

  it.live("proxies remote workspace HTTP requests with sanitized forwarding", () =>
    Effect.gen(function* () {
      Flag.MIAO_EXPERIMENTAL_WORKSPACES = true
      const dir = yield* tmpdirScoped({ git: true })
      const proxied: ProxiedRequest[] = []
      const remote = listenRemoteHttp((request) => {
        proxied.push(request)
        const url = new URL(request.url)
        if (url.pathname === "/base/global/event") return eventStreamResponse()
        if (url.pathname === "/base/event") return eventStreamResponse()
        if (url.pathname === "/base/sync/history") return Response.json([])
        return new Response(
          JSON.stringify({
            proxied: true,
            path: url.pathname,
            keep: url.searchParams.get("keep"),
            workspace: url.searchParams.get("workspace"),
          }),
          {
            status: 201,
            statusText: "Created",
            headers: {
              "content-length": "999",
              "content-type": "application/json",
              "x-remote": "yes",
            },
          },
        )
      })

      const project = yield* Project.use.fromDirectory(dir)
      registerAdapter(
        project.project.id,
        "remote-target",
        remoteAdapter(path.join(dir, ".remote"), `http://127.0.0.1:${remote.port}/base`, {
          "x-target-auth": "secret",
        }),
      )
      const created = yield* requestDefault(WorkspacePaths.list, dir, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "remote-target", branch: null }),
      })
      const workspace = (yield* created.json) as Workspace.Info

      const url = new URL("http://localhost/config")
      url.searchParams.set("workspace", workspace.id)
      url.searchParams.set("keep", "yes")

      try {
        const response = yield* requestDefault(url.toString(), dir, {
          method: "PATCH",
          headers: {
            "accept-encoding": "br",
            "content-type": "application/json",
            "x-opencode-workspace": "internal",
          },
          body: JSON.stringify({ $schema: "https://mtty.dev/miao/config.json" }),
        })

        const responseBody = yield* response.text
        expect({ status: response.status, body: responseBody }).toMatchObject({ status: 201 })
        expect(response.headers["content-length"]).toBeUndefined()
        expect(response.headers["x-remote"]).toBe("yes")
        expect(JSON.parse(responseBody)).toEqual({ proxied: true, path: "/base/config", keep: "yes", workspace: null })
        const forwarded = proxied.filter((item) => new URL(item.url).pathname === "/base/config")
        expect(forwarded).toEqual([
          {
            url: `http://127.0.0.1:${remote.port}/base/config?keep=yes`,
            method: "PATCH",
            headers: expect.objectContaining({
              "content-type": "application/json",
              "x-target-auth": "secret",
            }),
            body: JSON.stringify({ $schema: "https://mtty.dev/miao/config.json" }),
          },
        ])
        expect(forwarded[0]?.headers).not.toHaveProperty("x-opencode-directory")
        expect(forwarded[0]?.headers).not.toHaveProperty("x-opencode-workspace")

        const eventURL = new URL(`http://localhost${EventPaths.event}`)
        eventURL.searchParams.set("workspace", workspace.id)
        const eventResponse = yield* request(eventURL.toString(), dir)
        expect(eventResponse.status).toBe(200)
        expect(eventResponse.headers["content-type"]).toContain("text/event-stream")
        const event = Array.from(yield* eventResponse.stream.pipe(Stream.take(1), Stream.runCollect))[0]
        expect(new TextDecoder().decode(event)).toContain("server.connected")
        expect(proxied.some((item) => new URL(item.url).pathname === "/base/event")).toBe(true)
      } finally {
        void remote.stop(true)
        yield* requestDefault(WorkspacePaths.remove.replace(":id", workspace.id), dir, { method: "DELETE" })
      }
    }),
  )

})
