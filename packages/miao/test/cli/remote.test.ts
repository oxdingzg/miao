import { describe, expect, it } from "bun:test"
import { parseHubURL } from "@/cli/cmd/remote"

describe("parseHubURL", () => {
  it("prepends https to a bare host and normalizes to the origin", () => {
    expect(parseHubURL("hub.example.com")).toEqual({ hubURL: "https://hub.example.com" })
    expect(parseHubURL("hub.example.com/base/path")).toEqual({ hubURL: "https://hub.example.com" })
  })

  it("keeps explicit non-default ports", () => {
    expect(parseHubURL("https://hub.example.com:8443")).toEqual({ hubURL: "https://hub.example.com:8443" })
  })

  it("allows http only for loopback hosts and records the relaxation", () => {
    expect(parseHubURL("http://127.0.0.1:4600")).toEqual({
      hubURL: "http://127.0.0.1:4600",
      allowLoopbackHTTP: true,
    })
    expect(parseHubURL("http://localhost:4600")?.allowLoopbackHTTP).toBe(true)
  })

  it("rejects plain http on a public host", () => {
    expect(parseHubURL("http://hub.example.com")).toBeUndefined()
  })

  it("rejects input that does not parse as a URL", () => {
    expect(parseHubURL("not a url")).toBeUndefined()
  })
})
