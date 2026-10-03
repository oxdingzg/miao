import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

const text = (response: HttpClientResponse.HttpClientResponse) => response.text

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("schema-rejection wire shape", () => {
  it.instance(
    "v2 payload schema rejection returns InvalidRequestError JSON",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory("/api/worktree/reset", test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aggregate: -1 }),
        })
        expect(res.status).toBe(400)
        expect(res.headers["content-type"] ?? "").toContain("application/json")
        const parsed = JSON.parse(yield* text(res))
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: expect.stringMatching(/^(Body|Payload)$/) })
        expect(parsed.message).toEqual(expect.any(String))
        expect(parsed.message.length).toBeGreaterThan(0)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "v2 query schema rejection returns InvalidRequestError JSON",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory("/api/session?limit=0", test.directory)
        const parsed = JSON.parse(yield* text(res))
        expect(res.status).toBe(400)
        expect(parsed).toMatchObject({ _tag: "InvalidRequestError", kind: "Query" })
        expect(parsed.message).toEqual(expect.any(String))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejected request body never echoes back unbounded — message is capped",
    // Defense against DoS-amplification + secret-echo: Effect's Issue formatter
    // dumps the rejected `actual` verbatim. A multi-MB invalid array would
    // become a multi-MB 400 response and log line. Cap kicks in around 1KB.
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const huge = "X".repeat(50_000)
        const res = yield* requestInDirectory("/api/worktree/reset", test.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ aggregate: huge }),
        })
        const body = yield* text(res)
        expect(res.status).toBe(400)
        // 1 KB cap + small JSON envelope ≈ <2 KB — never tens of KB.
        expect(body.length).toBeLessThan(2 * 1024)
        const parsed = JSON.parse(body)
        expect(JSON.stringify(parsed)).not.toContain(huge)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
