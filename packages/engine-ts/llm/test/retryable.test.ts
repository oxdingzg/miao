import { describe, expect, test } from "bun:test"
import { InvalidRequestReason, UnknownProviderReason } from "../src"

describe("retryable classification of misclassified capacity errors", () => {
  test("capacity phrasing in an invalid-request reason is retryable", () => {
    const messages = [
      "Provider returned 400: model is overloaded, please try again",
      '{"error":{"message":"The server is currently at capacity"}}',
      "upstream temporarily unavailable, please retry",
      "model temporarily overloaded",
      "due to high demand, the service is saturated",
    ]

    expect(messages.every((message) => new InvalidRequestReason({ message }).retryable)).toBe(true)
  })

  test("capacity phrasing in an unknown-provider reason is retryable", () => {
    expect(new UnknownProviderReason({ message: "502 from gateway: overloaded_error" }).retryable).toBe(true)
  })

  test("genuinely invalid requests stay non-retryable", () => {
    const messages = [
      "Invalid parameter: temperature must be <= 2",
      "Content policy violation: the request contains disallowed content",
      "insufficient_quota: You exceeded your current quota",
      "model `nope-9` does not exist",
    ]

    expect(messages.every((message) => !new InvalidRequestReason({ message }).retryable)).toBe(true)
    expect(new UnknownProviderReason({ message: "model `nope-9` does not exist" }).retryable).toBe(false)
  })
})
