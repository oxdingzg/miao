import { expect } from "bun:test"
import { Socket } from "node:net"
import { DateTime, Effect, Layer, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { OpenCode } from "@miao/client"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Event } from "@miao/schema/event"
import { ClientEvents } from "@miao/server/client-events"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Server } from "../../src/server/server"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(AppNodeBuilder.build(ClientEvents.node).pipe(Layer.provideMerge(NodeServices.layer)))

async function until(test: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!test()) {
    if (Date.now() >= deadline) throw new Error("HTTP event condition not reached")
    await Bun.sleep(2)
  }
}

it.live(
  "a paused TCP SSE client overflows independently, while a healthy client and reconnect keep receiving",
  () =>
    Effect.gen(function* () {
      const clients = yield* ClientEvents.Service
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" }))
      const abort = new AbortController()
      const slow = new Socket()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          abort.abort()
          slow.destroy()
          await server.stop(true)
        }),
      )
      const sdk = OpenCode.make({ baseUrl: server.url.toString() })
      const received = new Set<string>()
      let healthyConnected = false
      let healthyFailure: unknown
      const healthy = (async () => {
        const events = await sdk.events.subscribe({ signal: abort.signal })
        for await (const event of events) {
          if (event.type === "server.connected") healthyConnected = true
          if (event.id.startsWith("evt_")) received.add(event.id)
        }
      })().catch((error: unknown) => {
        if (!abort.signal.aborted) healthyFailure = error
      })
      let paused = false
      let closed = false
      let responseEnded = false
      let responseTail = ""
      let header = ""
      slow.on("data", (chunk: Buffer) => {
        if (paused) {
          responseTail = (responseTail + chunk.toString()).slice(-128)
          if (responseTail.endsWith("0\r\n\r\n")) responseEnded = true
          return
        }
        header += chunk.toString()
        if (!header.includes("server.connected")) return
        paused = true
        header = ""
        slow.pause()
      })
      // A reset is an expected overflow outcome for the deliberately slow client.
      slow.on("error", () => {
        closed = true
      })
      slow.on("close", () => {
        closed = true
      })
      const port = server.port
      if (port === undefined) throw new Error("TCP server did not bind a port")
      slow.connect(port, "127.0.0.1", () => {
        slow.write(`GET /api/event HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`)
      })
      yield* Effect.promise(() => until(() => healthyConnected && paused))
      const delta = "x".repeat(4096)
      let last = ""
      // Enough real bytes to fill TCP send buffers before the bounded fan-out
      // queue. Drain the healthy peer between batches so only the slow one fills.
      for (let batch = 0; batch < 128; batch++) {
        for (let item = 0; item < 64; item++) {
          const event = Schema.decodeUnknownSync(Schema.toType(OpenCodeEvent))({
            id: Event.ID.create(),
            type: "session.next.text.delta",
            data: {
              timestamp: DateTime.makeUnsafe(1),
              sessionID: "ses_tcp_pressure",
              assistantMessageID: "msg_tcp_pressure",
              textID: "prt_tcp_pressure",
              delta,
            },
          })
          last = event.id
          yield* clients.publish(event)
        }
        const expected = last
        yield* Effect.promise(() => until(() => received.has(expected) || healthyFailure !== undefined))
        expect(healthyFailure).toBeUndefined()
      }
      slow.resume()
      yield* Effect.promise(() => until(() => closed || responseEnded))
      expect(received.has(last)).toBe(true)
      expect(healthyFailure).toBeUndefined()

      const reconnected = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => reconnected.abort()))
      const ready = Promise.withResolvers<void>()
      const final = Promise.withResolvers<string>()
      const probeID = Event.ID.create()
      const probe = (async () => {
        const events = await sdk.events.subscribe({ signal: reconnected.signal })
        for await (const event of events) {
          if (event.type === "server.connected") ready.resolve()
          if (event.id === probeID) {
            final.resolve(event.id)
            return
          }
        }
      })().catch(final.reject)
      yield* Effect.promise(() => ready.promise)
      yield* clients.publish(
        Schema.decodeUnknownSync(Schema.toType(OpenCodeEvent))({
          id: probeID,
          type: "session.next.text.delta",
          data: {
            timestamp: DateTime.makeUnsafe(2),
            sessionID: "ses_tcp_pressure",
            assistantMessageID: "msg_tcp_pressure",
            textID: "prt_tcp_pressure",
            delta: "after reconnect",
          },
        }),
      )
      expect(yield* Effect.promise(() => final.promise)).toBe(probeID)
      yield* Effect.promise(() => until(() => received.has(probeID)))
      reconnected.abort()
      abort.abort()
      yield* Effect.promise(() => Promise.all([healthy, probe]))
    }),
  20_000,
)

it.live(
  "a real HTTP durable subscriber resumes strictly after its cursor and follows new commits",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" }))
      const abort = new AbortController()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          abort.abort()
          await server.stop(true)
        }),
      )
      const sdk = OpenCode.make({ baseUrl: server.url.toString(), headers: { "x-opencode-directory": tmp } })
      const session = yield* Effect.promise(() => sdk.sessions.create({ location: { directory: tmp } }))
      const baseline = yield* Effect.promise(async () => {
        for await (const event of sdk.events.durable({ aggregateID: session.id }, { signal: abort.signal })) {
          if (event.durable?.aggregateID === session.id) return event
        }
        throw new Error("created cursor missing")
      })
      expect(baseline.durable?.seq).toBe(0)
      yield* Effect.promise(() => sdk.sessions.rename({ sessionID: session.id, title: "missed one" }))
      yield* Effect.promise(() => sdk.sessions.rename({ sessionID: session.id, title: "missed two" }))
      const observed: number[] = []
      const ids: string[] = []
      const following = (async () => {
        for await (const event of sdk.events.durable({ aggregateID: session.id, after: 0 }, { signal: abort.signal })) {
          if (event.durable?.aggregateID !== session.id) continue
          observed.push(event.durable.seq)
          ids.push(event.id)
          if (observed.length === 3) return
        }
      })()
      yield* Effect.promise(() => until(() => observed.length === 2))
      yield* Effect.promise(() => sdk.sessions.rename({ sessionID: session.id, title: "committed after reconnect" }))
      yield* Effect.promise(() => following)
      expect(observed).toEqual([1, 2, 3])
      expect(new Set(ids).size).toBe(3)
      expect((yield* Effect.promise(() => sdk.sessions.get({ sessionID: session.id }))).title).toBe(
        "committed after reconnect",
      )
    }),
  20_000,
)
