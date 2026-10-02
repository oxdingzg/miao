import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ProviderShared } from "../src/protocols/shared"
import type { MediaPart } from "../src/schema"
import { it } from "./lib/effect"

const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)

const media = (data: string | Uint8Array, mediaType = "image/png"): MediaPart => ({
  type: "media",
  mediaType,
  data,
})

const validate = (data: string | Uint8Array, mediaType?: string) =>
  Effect.result(ProviderShared.validateMedia("Test", media(data, mediaType), IMAGE_MIMES))

/** The rule the optimized validator replaces: decode, then re-encode and compare. */
const roundTrips = (base64: string) => Buffer.from(base64, "base64").toString("base64") === base64

/**
 * The pattern the scan replaces, kept as the oracle for the inputs it could still
 * answer. It is restated here rather than imported because the assertion is
 * "the scan agrees with the old rule", which needs the old rule written down.
 */
const patternAccepts = (value: string) =>
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)

const alphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"]

/**
 * Well-formed by construction — padding only trails, in the counts the old rule
 * allowed — so the round trip is the only thing the verdict may turn on. Each
 * variable character sweeps the whole alphabet, and the prefixed forms repeat it
 * at a non-zero offset so the position it is read from is exercised too.
 */
const wellFormed = alphabet.flatMap((char) => [
  `A${char}==`,
  `AA${char}=`,
  `AAA${char}`,
  `aGkA${char}==`,
  `aGkAA${char}=`,
  `aGkAAA${char}`,
])

/** Every string of one to four characters over a charset with padding and an outsider, unprefixed and prefixed. */
const shapes = [1, 2, 3, 4]
  .reduce<string[]>(
    (bodies) => bodies.flatMap((prefix) => [..."Aa=*"].map((char) => prefix + char)),
    [""],
  )
  .flatMap((body) => [body, `aGk${body}`])

describe("ProviderShared.validateMedia", () => {
  it.effect("accepts a media part exactly when the round trip does", () =>
    Effect.gen(function* () {
      const accepted: string[] = []
      const rejected: string[] = []
      for (const candidate of wellFormed) {
        const result = yield* validate(candidate)
        const outcome = result._tag === "Success"
        expect({ candidate, outcome }).toEqual({ candidate, outcome: roundTrips(candidate) })
        if (outcome) accepted.push(candidate)
        else rejected.push(candidate)
      }
      // A sweep where nothing lands on one side would prove nothing.
      expect(accepted.length).toBeGreaterThan(0)
      expect(rejected.length).toBeGreaterThan(0)
    }),
  )

  it.effect("returns the verdict the replaced validator returns", () =>
    Effect.gen(function* () {
      for (const candidate of shapes) {
        const result = yield* validate(candidate)
        // Charset and shape from the pattern, canonicality from the round trip:
        // the two halves of what the old implementation asked. The pattern only
        // answers for short inputs, which is why the scan exists, so these cases
        // stay well inside the size where it still returned one.
        expect({ candidate, outcome: result._tag === "Success" }).toEqual({
          candidate,
          outcome: patternAccepts(candidate) && roundTrips(candidate),
        })
      }
    }),
  )

  it.effect("accepts payloads past the size the replaced pattern stopped matching", () =>
    Effect.gen(function* () {
      // 6M characters hold 4.5MB, past the ~5.57M character cliff at which the
      // replaced pattern silently stopped matching, and inside both limits.
      const result = yield* validate("A".repeat(6_000_000))
      expect(result._tag).toBe("Success")
    }),
  )

  it.effect("rejects payloads one group either side of the decoded limit", () =>
    Effect.gen(function* () {
      // 27,962,024 base64 characters hold 20,971,518 bytes; the next group holds
      // 20,971,521. Both stay under the 28MiB encoded limit, so the decoded
      // arithmetic is what decides.
      const accepted = yield* validate("A".repeat(27_962_024))
      expect(accepted._tag).toBe("Success")
      const rejected = yield* validate("A".repeat(27_962_028))
      expect(rejected._tag).toBe("Failure")
      expect(rejected._tag === "Failure" ? String(rejected.failure) : "").toContain("decoded limit")
    }),
  )

  it.effect("accepts canonical base64 and lowercases the media type", () =>
    Effect.gen(function* () {
      const result = yield* validate("aGk=", "IMAGE/PNG")
      expect(result._tag === "Success" ? result.success : undefined).toEqual({ mime: "image/png", base64: "aGk=" })
    }),
  )

  it.effect("returns base64 that rebuilds the data URL it was given", () =>
    Effect.gen(function* () {
      const url = "data:image/png;base64,aGVsbG8="
      const result = yield* validate(url)
      expect(result._tag === "Success" ? ProviderShared.mediaDataUrl(result.success) : undefined).toBe(url)
    }),
  )

  it.effect("encodes raw bytes as canonical base64", () =>
    Effect.gen(function* () {
      const result = yield* validate(new Uint8Array([0x68, 0x69]))
      expect(result._tag === "Success" ? result.success.base64 : undefined).toBe("aGk=")
    }),
  )

  it.effect("rejects unsupported, mismatched and malformed media", () =>
    Effect.gen(function* () {
      for (const [data, mediaType] of [
        ["aGk=", "application/zip"],
        ["data:image/jpeg;base64,aGk=", undefined],
        ["aGk", undefined],
        ["aGk*", undefined],
        // `=` inside the data region, which an endsWith-derived pad count must not excuse.
        ["A===", undefined],
        ["AAAA====", undefined],
        ["", undefined],
      ] as const) {
        const result = yield* validate(data, mediaType)
        expect({ data, outcome: result._tag === "Success" }).toEqual({ data, outcome: false })
      }
    }),
  )
})
