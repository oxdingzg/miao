import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { ...init, headers }),
    context,
  )
}

const createSession = async (directory: string) => {
  const created = await request("/api/session", directory, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: { directory } }),
  })
  expect(created.status).toBe(200)
  return ((await created.json()) as { data: { id: string } }).data
}

const renameSession = async (directory: string, sessionID: string, title: string) => {
  const renamed = await request(`/api/session/${sessionID}/rename`, directory, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  expect(renamed.status).toBe(204)
}

// Collect SSE frames until the predicate matches, with a wall-clock bound so a
// missing frame fails the test instead of hanging it.
const readFrame = async (
  body: ReadableStream<Uint8Array>,
  until: (frame: { type: string; durable?: { seq: number; aggregateID: string } }) => boolean,
  budgetMs = 4000,
) => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + budgetMs
  try {
    while (Date.now() < deadline) {
      const chunk = (await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 500)),
      ])) as { done: boolean; value?: Uint8Array }
      if (chunk.done || chunk.value === undefined) break
      buffer += decoder.decode(chunk.value, { stream: true })
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary === -1) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n")
        if (!data || data === "{}") continue
        const parsed = JSON.parse(data) as { type: string; durable?: { seq: number; aggregateID: string } }
        if (parsed.type === "server.connected") continue
        if (until(parsed)) return parsed
      }
    }
    throw new Error(`expected frame did not arrive within ${budgetMs}ms`)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Durable event replay", () => {
  test("replays a session's committed durable log from the beginning", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await createSession(tmp.path)

    const replay = await request(`/api/event/durable?aggregateID=${session.id}`, tmp.path)
    expect(replay.status).toBe(200)
    expect(replay.headers.get("content-type")).toBe("text/event-stream")

    const first = await readFrame(replay.body!, (frame) => frame.type === "session.next.created")
    expect(first.durable).toMatchObject({ aggregateID: session.id, seq: 0 })
  })

  test("resumes after a cursor and follows events committed later", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await createSession(tmp.path)

    const replay = await request(`/api/event/durable?aggregateID=${session.id}`, tmp.path)
    const created = await readFrame(replay.body!, (frame) => frame.type === "session.next.created")
    expect(created.durable?.seq).toBe(0)

    // The cursor is exclusive: reopening after the created event replays
    // nothing until the next durable event commits, then delivers it.
    const resumed = await request(`/api/event/durable?aggregateID=${session.id}&after=0`, tmp.path)
    await renameSession(tmp.path, session.id, "renamed after cursor")
    const next = await readFrame(resumed.body!, (frame) => frame.durable !== undefined)
    expect(next.durable).toMatchObject({ aggregateID: session.id, seq: 1 })
  })
})
