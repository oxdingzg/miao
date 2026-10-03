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
