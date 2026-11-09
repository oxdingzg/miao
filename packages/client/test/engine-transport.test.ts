import { describe, expect, test } from "bun:test"
import { EngineError, EngineHttpClient, type EngineEvent, type EngineProgress } from "../src/engine"

const token = "test-token"

function engine(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const headers = { "miao-engine-protocol": "engine-http-0", "content-type": "application/json" }

describe("engine HTTP attachment", () => {
  test("refuses anything but an authenticated loopback origin", () => {
    expect(() => new EngineHttpClient({ url: "http://example.com:8080", token })).toThrow(EngineError)
    expect(() => new EngineHttpClient({ url: "http://127.0.0.1:8080", token: "" })).toThrow(EngineError)
    expect(() => new EngineHttpClient({ url: "http://127.0.0.1:8080/path", token })).toThrow(EngineError)
  })

  test("correlates replies and surfaces an engine error verbatim", async () => {
    const fake = engine(async (request) => {
      const body = (await request.json()) as { id: number; method: string; params?: unknown }
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 })
      if (body.method === "boom")
        return Response.json({ id: body.id, error: { code: "engine_boom", message: "it broke" } }, { headers })
      return Response.json({ id: body.id, result: { echo: body.params } }, { headers })
    })
    const client = new EngineHttpClient({ url: fake.url, token })
    try {
      expect(await client.request("ping", { a: 1 })).toEqual({ echo: { a: 1 } })
      const error = await client.request("boom").catch((error: unknown) => error)
      expect(error).toBeInstanceOf(EngineError)
      expect((error as EngineError).code).toBe("engine_boom")
      expect((error as EngineError).message).toBe("it broke")
    } finally {
      await client.close()
      fake.stop()
    }
  })

  test("omits empty params so an argument-less command stays argument-less", async () => {
    // Verified against a real engine: `{"id":1,"method":"sessions","params":{}}`
    // is rejected as an untyped request, while an absent or null `params` is the
    // argument-less variant. A caller doing `params ?? {}` must not break it.
    const bodies: string[] = []
    const fake = engine(async (request) => {
      const text = await request.text()
      bodies.push(text)
      const body = JSON.parse(text) as { id: number }
      return Response.json({ id: body.id, result: null }, { headers })
    })
    const client = new EngineHttpClient({ url: fake.url, token })
    try {
      await client.request("sessions")
      await client.request("sessions", {})
      await client.request("snapshot", { session_id: "ses_1" })
    } finally {
      await client.close()
      fake.stop()
    }
    expect(bodies[0]).toBe('{"id":1,"method":"sessions"}')
    expect(bodies[1]).toBe('{"id":2,"method":"sessions"}')
    expect(bodies[2]).toBe('{"id":3,"method":"snapshot","params":{"session_id":"ses_1"}}')
  })

  test("rejects a reply carrying another protocol revision", async () => {
    const fake = engine(async (request) => {
      const body = (await request.json()) as { id: number }
      return Response.json({ id: body.id, result: null }, { headers: { "miao-engine-protocol": "engine-http-9" } })
    })
    const client = new EngineHttpClient({ url: fake.url, token })
    try {
      const error = await client.request("ping").catch((error: unknown) => error)
      expect((error as EngineError).code).toBe("engine_protocol")
    } finally {
      await client.close()
      fake.stop()
    }
  })

  test("delivers committed events in cursor order and drops a replayed seq", async () => {
    const fake = engine((request) => {
      const url = new URL(request.url)
      if (url.pathname !== "/events") return new Response(null, { status: 404 })
      expect(url.searchParams.get("session_id")).toBe("ses_1")
      expect(url.searchParams.get("after")).toBe("1")
      const frames = [
        { session_id: "ses_1", seq: 2, kind: "message.updated", data: { text: "a" } },
        { session_id: "ses_1", seq: 2, kind: "message.updated", data: { text: "a" } },
        { session_id: "ses_1", seq: 3, kind: "message.updated", data: { text: "b" }, recorded_at_ms: 42 },
      ]
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          for (const frame of frames)
            controller.enqueue(encoder.encode(`event: event\ndata: ${JSON.stringify(frame)}\n\n`))
          controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify({ kind: "provider.delta" })}\n\n`))
          controller.close()
        },
      })
      return new Response(body, { headers })
    })
    const client = new EngineHttpClient({ url: fake.url, token })
    const events: EngineEvent[] = []
    const progress: EngineProgress[] = []
    client.onEvent((event) => events.push(event))
    client.onProgress((event) => progress.push(event))
    try {
      await client.subscribe("ses_1", 1)
      // The fake closes its stream after the last frame, which the attachment
      // reports as a failed stream; the delivered frames stay observable.
      for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(10)
      expect(events.map((event) => event.seq)).toEqual([2, 3])
      expect(events[1]?.recorded_at_ms).toBe(42)
      expect(progress).toEqual([{ kind: "provider.delta", session_id: "ses_1" }])
    } finally {
      await client.close()
      fake.stop()
    }
  })
})
