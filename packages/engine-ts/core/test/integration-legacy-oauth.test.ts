import { describe, expect, test } from "bun:test"
import { Integration } from "@miao/core/integration"

const methodID = Integration.MethodID.make("chatgpt-browser")

describe("Integration.legacyOAuth", () => {
  test("maps a legacy auth.json OAuth entry onto a V2 credential", () => {
    const credential = Integration.legacyOAuth(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_790_000_000_000,
        accountId: "account-id",
      },
      methodID,
    )

    expect(credential).toMatchObject({
      type: "oauth",
      methodID,
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_790_000_000_000,
      metadata: { accountID: "account-id" },
    })
  })

  test("accepts an entry without expiry or account", () => {
    const before = Date.now()
    const credential = Integration.legacyOAuth(
      { type: "oauth", access: "access-token", refresh: "refresh-token" },
      methodID,
    )

    expect(credential?.expires).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(credential?.metadata).toBeUndefined()
  })

  test("ignores entries that are not a legacy OAuth login", () => {
    expect(Integration.legacyOAuth({ type: "api", key: "key" }, methodID)).toBeUndefined()
    expect(Integration.legacyOAuth({ type: "oauth", access: "access-token" }, methodID)).toBeUndefined()
    expect(Integration.legacyOAuth(undefined, methodID)).toBeUndefined()
  })
})
