import { expect } from "bun:test"
import { createServer, type Socket } from "node:net"
import { Effect } from "effect"
import { TransportKeepAlive } from "../src/route"
import { it } from "./lib/effect"

it.effect("expires the stale window and clears on demand", () =>
  Effect.sync(() => {
    TransportKeepAlive.clearStale()
    TransportKeepAlive.markStale(1000)
    expect(TransportKeepAlive.isStale(1000)).toBe(true)
    expect(TransportKeepAlive.isStale(1000 + TransportKeepAlive.STALE_WINDOW_MS - 1)).toBe(true)
    expect(TransportKeepAlive.isStale(1000 + TransportKeepAlive.STALE_WINDOW_MS)).toBe(false)
    TransportKeepAlive.markStale(0)
    TransportKeepAlive.clearStale()
    expect(TransportKeepAlive.isStale(Date.now())).toBe(false)
  }),
)

it.live("stops reusing pooled sockets while the latch is set", () =>
  Effect.gen(function* () {
    let connections = 0
    const sockets: Socket[] = []
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
            const server = createServer((socket) => {
              connections++
              sockets.push(socket)
              let buffer = ""
              socket.on("data", (chunk) => {
                buffer += chunk.toString()
                if (!buffer.includes("\r\n\r\n")) return
                buffer = ""
                socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
              })
              socket.on("error", () => {})
            })
            server.once("error", reject)
            server.listen(0, "127.0.0.1", () => resolve(server))
          }),
      ),
      (server) =>
        Effect.sync(() => {
          sockets.forEach((socket) => socket.destroy())
          server.close()
        }),
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing server address")
    const hit = Effect.promise(async () => {
      const response = await TransportKeepAlive.guardedFetch(`http://127.0.0.1:${address.port}/x`)
      await response.text()
    })

    TransportKeepAlive.clearStale()
    yield* Effect.forEach([1, 2, 3], () => hit, { discard: true })
    expect(connections).toBe(1)

    TransportKeepAlive.markStale()
    yield* Effect.forEach([1, 2, 3], () => hit, { discard: true })
    expect(connections).toBe(4)

    TransportKeepAlive.clearStale()
  }),
)
