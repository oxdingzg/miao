import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { CommandCode } from "@miao/core/commandcode"

/**
 * The browser-assisted login posts the API key to a per-login loopback server.
 * These tests drive that server over real HTTP, because the failure they guard
 * against (`Invalid state token`) only shows up in request handling.
 * `authorizeDetached` is used directly so the loopback port stays reachable
 * while we post to it.
 */
const callbackURL = (url: string) => new URL(url).searchParams.get("callback")!
const stateOf = (url: string) => new URL(url).searchParams.get("state")!

/** Open a login on a scope that stays open until the returned close runs. */
const openLogin = async () => {
  const scope = await Effect.runPromise(Scope.make())
  const session = await Effect.runPromise(CommandCode.authorizeDetached().pipe(Scope.provide(scope)))
  return { ...session, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

const post = (url: string, body: unknown) =>
  fetch(callbackURL(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

describe("CommandCode login callback", () => {
  test("delivers a callback carrying the matching state", async () => {
    const session = await openLogin()
    try {
      const response = await post(session.url, { apiKey: "key-1", state: stateOf(session.url) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect((await Effect.runPromise(session.callback)).apiKey).toBe("key-1")
    } finally {
      await session.close()
    }
  })

  test("delivers a callback that omits state to the server that received it", async () => {
    const session = await openLogin()
    try {
      const response = await post(session.url, { apiKey: "key-2" })
      expect(response.status).toBe(200)
      expect((await Effect.runPromise(session.callback)).apiKey).toBe("key-2")
    } finally {
      await session.close()
    }
  })

  test("routes each state-less callback to its own login", async () => {
    const first = await openLogin()
    const second = await openLogin()
    try {
      await post(first.url, { apiKey: "key-first" })
      await post(second.url, { apiKey: "key-second" })
      expect((await Effect.runPromise(first.callback)).apiKey).toBe("key-first")
      expect((await Effect.runPromise(second.callback)).apiKey).toBe("key-second")
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("rejects a callback whose state names another login", async () => {
    const first = await openLogin()
    const second = await openLogin()
    try {
      const response = await post(second.url, { apiKey: "key-3", state: stateOf(first.url) })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ success: false, error: "Invalid state token" })
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("rejects a callback with an unknown state", async () => {
    const session = await openLogin()
    try {
      const response = await post(session.url, { apiKey: "key-4", state: "not-the-state" })
      expect(response.status).toBe(403)
    } finally {
      await session.close()
    }
  })

  test("rejects a callback with no API key", async () => {
    const session = await openLogin()
    try {
      const response = await post(session.url, { state: stateOf(session.url) })
      expect(response.status).toBe(403)
    } finally {
      await session.close()
    }
  })
})
