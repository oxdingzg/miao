/**
 * Regression tests for the SDK error shape — the v2 SDK's `throwOnError: true`
 * path used to throw raw values (empty strings or POJOs from JSON-decoded
 * error bodies). The TUI catches those and `e.message`/`e.stack` are
 * undefined, so users see `[object Object]` or a blank crash.
 *
 * Both cases must throw a real `Error` instance with a non-empty `.message`
 * extracted from the response body, plus `.status` and `.body` attached.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createMiaoClient } from "@miao/sdk/v2"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string) {
  return createMiaoClient({
    baseUrl: "http://test",
    directory,
    fetch: ((req: Request) => Server.Default().app.fetch(req)) as unknown as typeof fetch,
  })
}

describe("v2 SDK error shape", () => {
  test("404 with V2 error body throws a real Error carrying the server message", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)

    const caught = await sdk.v2.session
      .get({ sessionID: "ses_no_such" }, { throwOnError: true })
      .catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error
    const cause = err.cause as { body?: { _tag: string; message: string; kind?: string }; status?: number }
    expect(err.message).toContain("Session not found")
    expect(cause.status).toBe(404)
    expect(cause.body).toMatchObject({
      _tag: "SessionNotFoundError",
      message: expect.stringContaining("Session not found"),
    })
  })

  test("400 schema rejection throws a real Error carrying the V2 server message", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)
    const caught = await sdk.v2.session.list({ limit: -1 }, { throwOnError: true }).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error
    const cause = err.cause as { body: { _tag: string; message: string }; status: number }
    expect(cause.status).toBe(400)
    expect(cause.body._tag).toBe("InvalidRequestError")
    expect(cause.body.message.length).toBeGreaterThan(0)
    expect(err.message).toBe(cause.body.message)
  })
})
