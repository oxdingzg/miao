import { describe, expect, test } from "bun:test"
import { detectServerProtocol, protocolOverride } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const mockFetch = (run: (input: string | URL | Request) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("prefers the legacy health endpoint when both API generations exist", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("recognizes V2 health by its process identifier", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes the transitional V1 API health response", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("an explicit override wins over detection", async () => {
    const fetcher = mockFetch(() => Promise.resolve(json({ healthy: true, version: "1.18.4" })))
    expect(await detectServerProtocol(server, fetcher, "v2")).toBe("v2")
    expect(await detectServerProtocol(server, fetcher, "v1")).toBe("v1")
  })

  test("parses the ?protocol override from a query string", () => {
    expect(protocolOverride("?protocol=v2")).toBe("v2")
    expect(protocolOverride("protocol=v1&x=1")).toBe("v1")
    expect(protocolOverride("?protocol=other")).toBeUndefined()
    expect(protocolOverride(undefined)).toBeUndefined()
  })
})
