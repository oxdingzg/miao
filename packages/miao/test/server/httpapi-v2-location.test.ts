import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { Context, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("execution observation and targeted interruption validate identity and session ownership", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    expect(created.status).toBe(200)
    const id = ((await created.json()) as { data: { id: string } }).data.id
    const state = await request(`/api/session/${id}/execution`, tmp.path)
    expect(state.status).toBe(200)
    expect(await state.json()).toEqual({ type: "idle" })
    const stale = await request(
      `/api/session/${id}/execution/00000000-0000-4000-8000-000000000000/interrupt`,
      tmp.path,
      {
        method: "POST",
      },
    )
    expect(stale.status).toBe(409)
    const malformed = await request(`/api/session/${id}/execution/not-an-execution/interrupt`, tmp.path, {
      method: "POST",
    })
    expect(malformed.status).toBe(400)
    const missing = await request("/api/session/ses_missing_execution/execution", tmp.path)
    expect(missing.status).toBe(404)
    const legacy = await request(`/api/session/${id}/interrupt`, tmp.path, { method: "POST" })
    expect(legacy.status).toBe(204)
  })

  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("lists and renames projects", async () => {
    await using tmp = await tmpdir({ git: true })
    const current = (await (await request("/api/project/current", tmp.path)).json()) as { data: { id: string } }

    const events = await request("/api/event", tmp.path)
    const reader = eventStream(events.body!)
    expect((await readEvent(reader)).type).toBe("server.connected")

    const updated = await request(`/api/project/${current.data.id}`, tmp.path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", icon: { color: "blue" } }),
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { data: unknown }).data).toMatchObject({
      id: current.data.id,
      name: "Renamed",
      icon: { color: "blue" },
    })
    expect(await readEventType(reader, "project.updated")).toMatchObject({
      data: { id: current.data.id, name: "Renamed" },
    })
    await reader.return(undefined)

    // Renaming recorded a project that had no session yet.
    const listed = (await (await request("/api/project", tmp.path)).json()) as {
      data: { id: string; worktree: string; name?: string }[]
    }
    expect(listed.data.find((project) => project.id === current.data.id)).toMatchObject({
      worktree: tmp.path,
      name: "Renamed",
    })

    const missing = await request("/api/project/prj_missing", tmp.path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    })
    expect(missing.status).toBe(404)
  })

  test("lists only top-level sessions when roots is set", async () => {
    await using tmp = await tmpdir({ git: true })
    const create = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    const parent = ((await create.json()) as { data: { id: string } }).data.id
    const fork = await request(`/api/session/${parent}/fork`, tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(fork.status).toBe(200)
    const child = ((await fork.json()) as { data: { id: string } }).data.id

    const ids = async (query: string) =>
      (
        (await (await request(`/api/session?directory=${encodeURIComponent(tmp.path)}${query}`, tmp.path)).json()) as {
          data: { id: string }[]
        }
      ).data.map((session) => session.id)
    expect((await ids("")).toSorted()).toEqual([parent, child].toSorted())
    expect(await ids("&roots=true")).toEqual([parent])
  })

  test("writes the global config and serves it to an already opened location", async () => {
    await using tmp = await tmpdir({ git: true })
    const patch = (body: unknown) =>
      request("/api/config", tmp.path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: body }),
      })
    const shell = async () =>
      ((await (await request("/api/config", tmp.path)).json()) as { data: { shell?: string } }).data.shell
    expect(await shell()).toBeUndefined()

    const reader = eventStream((await request("/api/event", tmp.path)).body!)
    expect((await readEvent(reader)).type).toBe("server.connected")
    try {
      const written = await patch({ shell: "/bin/test-shell" })
      expect(written.status).toBe(200)
      expect(await readEventType(reader, "config.updated")).toMatchObject({ type: "config.updated" })
      expect(await shell()).toBe("/bin/test-shell")
      // The test preload points the user config directory at a temporary one; the write lands in its
      // highest-priority global file, which another test file may already have created.
      const directory = path.join(process.env.XDG_CONFIG_HOME!, "miao")
      const files = await Promise.all(
        ["miao.json", "miao.jsonc", "opencode.json", "opencode.jsonc"].map((name) =>
          Bun.file(path.join(directory, name))
            .text()
            .catch(() => ""),
        ),
      )
      expect(files.some((text) => text.includes("/bin/test-shell"))).toBe(true)

      expect((await patch({ disabled_providers: ["openai"] })).status).toBe(400)
    } finally {
      await reader.return(undefined)
      await patch({ shell: null })
    }
    expect(await shell()).toBeUndefined()
  })

  test("stores a key for a provider the config just defined", async () => {
    await using tmp = await tmpdir({ git: true })
    const json = (method: string, body: unknown) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    try {
      const defined = await request(
        "/api/config",
        tmp.path,
        json("PATCH", {
          config: {
            providers: {
              "custom-e2e": {
                name: "Custom E2E",
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://example.test", settings: {} },
                models: { chat: { name: "Chat" } },
              },
            },
          },
        }),
      )
      expect(defined.status).toBe(200)

      const connected = await request("/api/integration/custom-e2e/connect/key", tmp.path, json("POST", { key: "k" }))
      expect(connected.status).toBe(204)
      const integration = (await (await request("/api/integration/custom-e2e", tmp.path)).json()) as {
        data: { connections: { type: string; id: string }[] }
      }
      const credentials = integration.data.connections.filter((connection) => connection.type === "credential")
      expect(credentials).toHaveLength(1)
      await request(`/api/credential/${credentials[0]!.id}`, tmp.path, { method: "DELETE" })
    } finally {
      await request("/api/config", tmp.path, json("PATCH", { config: { providers: { "custom-e2e": null } } }))
    }
  })

  test("registers a project when its directory is first opened", async () => {
    await using tmp = await tmpdir({ git: true })
    const current = (await (await request("/api/project/current", tmp.path)).json()) as { data: { id: string } }
    const listed = (await (await request("/api/project", tmp.path)).json()) as {
      data: { id: string; worktree: string; vcs?: string }[]
    }
    expect(listed.data.find((project) => project.id === current.data.id)).toMatchObject({
      worktree: tmp.path,
      vcs: "git",
    })
  })

  test("initializes git and records when /init ran", async () => {
    await using tmp = await tmpdir()
    const initialized = await request("/api/project/git/init", tmp.path, { method: "POST" })
    expect(initialized.status).toBe(200)
    expect(((await initialized.json()) as { data: unknown }).data).toMatchObject({ vcs: "git", worktree: tmp.path })
    expect(await Bun.file(path.join(tmp.path, ".git", "HEAD")).exists()).toBe(true)

    await using repo = await tmpdir({ git: true })
    const created = await request("/api/session", repo.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: repo.path } }),
    })
    const session = ((await created.json()) as { data: { id: string; projectID: string } }).data
    const command = await request(`/api/session/${session.id}/command`, repo.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "init", arguments: "", resume: false }),
    })
    expect(command.status).toBe(204)
    const projects = (await (await request("/api/project", repo.path)).json()) as {
      data: { id: string; time: { initialized?: number } }[]
    }
    expect(projects.data.find((project) => project.id === session.projectID)?.time.initialized).toBeNumber()
  })

  test("reports the home, config, and checkout paths of a location", async () => {
    await using repo = await tmpdir({ git: true })
    const inRepo = (await (await request("/api/path", repo.path)).json()) as Record<string, string>
    expect(inRepo).toMatchObject({ worktree: repo.path, directory: repo.path })
    expect(inRepo.home).toBeTruthy()
    expect(inRepo.config).toBeTruthy()

    await using plain = await tmpdir()
    expect(await (await request("/api/path", plain.path)).json()).toMatchObject({
      worktree: "/",
      directory: plain.path,
    })
  })

  test("creates, resets, and removes a project worktree", async () => {
    await using repo = await tmpdir({ git: true })
    const json = (method: string, body: unknown) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const current = (await (await request("/api/project/current", repo.path)).json()) as { data: { id: string } }
    const reader = eventStream((await request("/api/event", repo.path)).body!)
    expect((await readEvent(reader)).type).toBe("server.connected")

    const created = await request("/api/worktree", repo.path, json("POST", { name: "route test" }))
    expect(created.status).toBe(200)
    const info = ((await created.json()) as { data: { name: string; branch: string; directory: string } }).data
    expect(info).toMatchObject({ name: "route-test", branch: "miao/route-test" })
    expect(await readEventType(reader, "worktree.ready")).toMatchObject({ location: { directory: info.directory } })
    await reader.return(undefined)

    const listed = (await (await request(`/api/project/${current.data.id}/directories`, repo.path)).json()) as {
      data: { directory: string }[]
    }
    expect(listed.data.map((item) => item.directory)).toContain(info.directory)

    await Bun.write(path.join(info.directory, "scratch.txt"), "untracked\n")
    const reset = await request("/api/worktree/reset", repo.path, json("POST", { directory: info.directory }))
    expect(reset.status).toBe(200)
    expect(await Bun.file(path.join(info.directory, "scratch.txt")).exists()).toBe(false)
    expect((await request("/api/worktree/reset", repo.path, json("POST", { directory: repo.path }))).status).toBe(400)

    const removed = await request("/api/worktree", repo.path, json("DELETE", { directory: info.directory }))
    expect(removed.status).toBe(200)
    expect(await Bun.file(path.join(info.directory, ".git")).exists()).toBe(false)
  })

  test("rejects MCP OAuth for unknown and local servers", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { mcp: { local: { type: "local", command: ["true"], enabled: false } } },
    })

    expect((await request("/api/mcp/missing/auth", tmp.path, { method: "POST" })).status).toBe(404)
    expect((await request("/api/mcp/missing/auth", tmp.path, { method: "DELETE" })).status).toBe(404)
    const local = await request("/api/mcp/local/auth", tmp.path, { method: "POST" })
    expect(local.status).toBe(400)
    expect(await local.json()).toMatchObject({ _tag: "InvalidRequestError", kind: "Mcp" })
  })

  test("lists the host shells", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/pty/shells", tmp.path)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { path: string; name: string; acceptable: boolean }[] }
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.some((shell) => shell.acceptable)).toBe(true)
  })

  test("returns working-tree and branch diffs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "tracked.txt"), "one\n")
    await $`git add tracked.txt && git commit -m tracked`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "tracked.txt"), "one\ntwo\n")
    await Bun.write(path.join(tmp.path, "untracked.txt"), "new\n")

    const working = await request("/api/vcs/diff?mode=working", tmp.path)
    expect(working.status).toBe(200)
    const body = (await working.json()) as {
      data: { file: string; patch: string; additions: number; deletions: number; status: string }[]
    }
    expect(body.data.map((item) => [item.file, item.status, item.additions, item.deletions])).toEqual([
      ["tracked.txt", "modified", 1, 0],
      ["untracked.txt", "added", 1, 0],
    ])
    expect(body.data[0]?.patch).toContain("+two")

    // The default branch has no divergence from itself.
    const branch = await request("/api/vcs/diff?mode=branch", tmp.path)
    expect(branch.status).toBe(200)
    expect(((await branch.json()) as { data: unknown[] }).data).toEqual([])
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/api/session", publisher.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { directory: publisher.path } }),
    })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.next.created")).toMatchObject({
      type: "session.next.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
