import { describe, expect, test } from "bun:test"
import { NamedError } from "@miao/core/util/error"
import { SessionV1 } from "@miao/core/v1/session"

describe("util.error", () => {
  test("schema-backed named errors are real NamedError instances", () => {
    const error = new SessionV1.AuthError({ providerID: "anthropic", message: "boom" })

    expect(error).toBeInstanceOf(NamedError)
    expect(error.toObject()).toEqual({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "boom" } })
  })

  test("named errors without fields serialize data", () => {
    expect(new SessionV1.OutputLengthError({}).toObject()).toEqual({ name: "MessageOutputLengthError", data: {} })
  })
})
