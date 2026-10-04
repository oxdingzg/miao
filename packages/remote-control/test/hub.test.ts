import { afterEach, describe, expect, test } from "bun:test"
import { ControlHub } from "../src/hub"

const hostID = "host-one-00000000"
const otherID = "host-two-00000000"
const token = "test-host-credential-000000000000000000000000"
const servers: ReturnType<typeof ControlHub.listen>[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.close())
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})
function start(extra: Partial<ControlHub.Options> = {}) {
  const server = ControlHub.listen({
    hosts: new Map([
      [hostID, token],
      [otherID, token],
    ]),
    port: 0,
    ...extra,
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}
async function connect(url: string, host = false) {
  const socket = new WebSocket(
    url.replace("http:", "ws:"),
    host ? { headers: { authorization: `Bearer ${token}` } } : {},
  )
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to connect")), { once: true })
  })
  return socket
}
function message(socket: WebSocket) {
  return new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  )
}
function closed(socket: WebSocket) {
  return new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }))
}
function hostURL(base: string, id = hostID) {
  return `${base}/v1/host?hostID=${id}&runtimeID=runtime-0000000000`
}

describe("Remote Control opaque Hub", () => {
  test("authenticates hosts and rejects duplicate ownership", async () => {
    const base = start()
    expect((await fetch(hostURL(base))).status).toBe(401)
    await connect(hostURL(base), true)
    expect((await fetch(hostURL(base), { headers: { authorization: `Bearer ${token}` } })).status).toBe(409)
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  test("forwards ciphertext in both directions with connection isolation", async () => {
    const base = start()
    const host = await connect(hostURL(base), true)
    const firstJoined = message(host)
    const first = await connect(`${base}/v1/client?hostID=${hostID}`)
    const firstID = JSON.parse(await firstJoined).connectionID as string
    const secondJoined = message(host)
    const second = await connect(`${base}/v1/client?hostID=${hostID}`)
    const secondID = JSON.parse(await secondJoined).connectionID as string
    expect(firstID).not.toBe(secondID)
    const upstream = message(host)
    first.send("c2VhbGVkLWZyYW1l")
    expect(JSON.parse(await upstream)).toEqual({ type: "frame", connectionID: firstID, payload: "c2VhbGVkLWZyYW1l" })
    const downstream = message(second)
    host.send(JSON.stringify({ type: "frame", connectionID: secondID, payload: "ZW5jcnlwdGVkLXJlc3VsdA==" }))
    expect(await downstream).toBe("ZW5jcnlwdGVkLXJlc3VsdA==")
  })

  test("disconnects clients when the runtime leaves and allows a fresh runtime", async () => {
    const base = start()
    const host = await connect(hostURL(base), true)
    const client = await connect(`${base}/v1/client?hostID=${hostID}`)
    const disconnected = closed(client)
    host.close()
    expect((await disconnected).code).toBe(1012)
    expect((await fetch(`${base}/v1/client?hostID=${hostID}`)).status).toBe(503)
    await connect(hostURL(base), true)
    expect((await fetch(hostURL(base), { headers: { authorization: `Bearer ${token}` } })).status).toBe(409)
  })

  test("enforces client limits and browser origins", async () => {
    const base = start({ maxClientsPerHost: 1, origins: new Set(["https://control.example"]) })
    expect((await fetch(hostURL(base), { headers: { origin: "https://untrusted.example" } })).status).toBe(403)
    await connect(hostURL(base), true)
    await connect(`${base}/v1/client?hostID=${hostID}`)
    expect((await fetch(`${base}/v1/client?hostID=${hostID}`)).status).toBe(429)
  })

  test("rejects malformed routing rather than forwarding application text", async () => {
    const base = start()
    const host = await connect(hostURL(base), true)
    const client = await connect(`${base}/v1/client?hostID=${hostID}`)
    const rejected = closed(client)
    client.send("plaintext request")
    expect((await rejected).code).toBe(1008)
    const rejectedHost = closed(host)
    host.send('{"type":"frame","connectionID":"bad","payload":"abc"}')
    expect((await rejectedHost).code).toBe(1008)
  })

  test("never routes frames to clients belonging to another host", async () => {
    const base = start()
    const first = await connect(hostURL(base), true)
    const second = await connect(hostURL(base, otherID), true)
    const joined = message(second)
    const client = await connect(`${base}/v1/client?hostID=${otherID}`)
    const connectionID = JSON.parse(await joined).connectionID as string
    const received: string[] = []
    client.addEventListener("message", (event) => received.push(String(event.data)))
    first.send(JSON.stringify({ type: "frame", connectionID, payload: "Zm9yZWlnbg==" }))
    const delivered = message(client)
    second.send(JSON.stringify({ type: "frame", connectionID, payload: "b3du" }))
    expect(await delivered).toBe("b3du")
    expect(received).toEqual(["b3du"])
  })
})
