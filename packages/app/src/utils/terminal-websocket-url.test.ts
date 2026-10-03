import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("uses the ticketed PTY route", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      ticket: "connect-ticket",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.pathname).toBe("/api/pty/pty_test/connect")
    expect(url.searchParams.get("location[directory]")).toBe("/tmp/project")
    expect(url.searchParams.get("cursor")).toBe("0")
    expect(url.searchParams.get("ticket")).toBe("connect-ticket")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("upgrades https to wss and omits a missing ticket", () => {
    const url = terminalWebSocketURL({
      url: "https://example.test/base",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 12,
    })

    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/base/api/pty/pty_test/connect")
    expect(url.searchParams.get("cursor")).toBe("12")
    expect(url.searchParams.has("ticket")).toBe(false)
  })
})
