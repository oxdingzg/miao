/**
 * Declared Promise-client failures preserve their tagged wire values. UI error
 * formatting consumes their message without depending on Error subclass identity.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@/client"
import { isInvalidRequestError, isSessionNotFoundError } from "@miao/client"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string) {
  return createClient({
    baseUrl: "http://test",
    directory,
    fetch: ((req: Request) => Server.Default().app.fetch(req)) as unknown as typeof fetch,
  })
}

describe("v2 SDK error shape", () => {
  test("404 preserves the declared session error and server message", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)

    const caught = await sdk.sessions.get({ sessionID: "ses_no_such" }).catch((error: unknown) => error)

    if (!isSessionNotFoundError(caught)) throw new Error("Expected SessionNotFoundError")
    expect(caught.sessionID).toBe("ses_no_such")
    expect(caught.message).toContain("Session not found")
  })

  test("400 preserves the declared schema rejection and server message", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)
    const caught = await sdk.sessions.list({ limit: -1 }).catch((error: unknown) => error)

    if (!isInvalidRequestError(caught)) throw new Error("Expected InvalidRequestError")
    expect(caught.message.length).toBeGreaterThan(0)
  })
})
