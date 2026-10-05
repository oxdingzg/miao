import { describe, expect, test } from "bun:test"
import type { Location } from "@miao/core/location"
import { inScope, subscriberScope } from "../src/handlers/event-scope"

const ref = (directory: string, workspaceID?: string) => ({ directory, workspaceID }) as Location.Ref

describe("subscriberScope", () => {
  test("reads the location query params", () => {
    expect(
      subscriberScope({
        url: "http://test/api/event?location%5Bdirectory%5D=%2Fwork%2Fapp&location%5Bworkspace%5D=ws_1",
        headers: {},
      }),
    ).toEqual({ directory: "/work/app", workspaceID: "ws_1" })
  })

  test("falls back to the encoded directory header", () => {
    expect(
      subscriberScope({ url: "http://test/api/event", headers: { "x-opencode-directory": "%2Fwork%2Fapp" } }),
    ).toEqual({ directory: "/work/app", workspaceID: undefined })
  })

  test("is undefined when the client names no directory", () => {
    expect(subscriberScope({ url: "http://test/api/event", headers: {} })).toBeUndefined()
  })
})

describe("inScope", () => {
  test("keeps server-wide events and unscoped subscribers", () => {
    expect(inScope(undefined, { directory: "/work/app" })).toBe(true)
    expect(inScope(ref("/work/other"), undefined)).toBe(true)
  })

  test("keeps a session in the subscriber's directory tree", () => {
    expect(inScope(ref("/work/app"), { directory: "/work/app" })).toBe(true)
    expect(inScope(ref("/work/app/packages/tui"), { directory: "/work/app" })).toBe(true)
    expect(inScope(ref("/work/app"), { directory: "/work/app/packages/tui" })).toBe(true)
  })

  test("drops a sibling project and a prefix that is not a path boundary", () => {
    expect(inScope(ref("/work/other"), { directory: "/work/app" })).toBe(false)
    expect(inScope(ref("/work/app-extra"), { directory: "/work/app" })).toBe(false)
  })

  test("compares by workspace when either side has one", () => {
    expect(inScope(ref("/work/app", "ws_1"), { directory: "/elsewhere", workspaceID: "ws_1" })).toBe(true)
    expect(inScope(ref("/work/app", "ws_1"), { directory: "/work/app", workspaceID: "ws_2" })).toBe(false)
    expect(inScope(ref("/work/app", "ws_1"), { directory: "/work/app" })).toBe(false)
  })
})
