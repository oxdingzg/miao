import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { legacyRoute, legacyRouteLayer } from "../../src/server/routes/instance/httpapi/middleware/legacy-route"

describe("legacy-route logging", () => {
  test("names V1 session-family routes with IDs collapsed", () => {
    expect(legacyRoute("GET", "/session")).toBe("GET /session")
    expect(legacyRoute("GET", "/session/ses_abc123/message/msg_def456")).toBe("GET /session/:id/message/:id")
    expect(legacyRoute("POST", "/permission/per_1/reply")).toBe("POST /permission/:id/reply")
    expect(legacyRoute("GET", "/question")).toBe("GET /question")
    expect(legacyRoute("POST", "/experimental/session/ses_1/background")).toBe(
      "POST /experimental/session/:id/background",
    )
    expect(legacyRoute("GET", "/api/session/ses_1")).toBeUndefined()
    expect(legacyRoute("GET", "/config")).toBeUndefined()
    expect(legacyRoute("GET", "/sessions")).toBeUndefined()
  })

  test("warns once per V1 hit with the route and user agent", async () => {
    const lines: { level: string; message: unknown }[] = []
    const capture = Logger.make((options) => lines.push({ level: options.logLevel, message: options.message }))
    const routes = HttpRouter.use((router) =>
      Effect.all([
        router.add("GET", "/session/:id", () => Effect.succeed(HttpServerResponse.text("v1"))),
        router.add("GET", "/api/session/:id", () => Effect.succeed(HttpServerResponse.text("v2"))),
      ]),
    )
    // Requests run on their own fibers, so the capturing logger is installed per request,
    // by a middleware merged before the one under test so it wraps it.
    const captureLayer = HttpRouter.middleware((effect) => effect.pipe(Effect.provide(Logger.layer([capture]))), {
      global: true,
    })
    const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(routes, captureLayer, legacyRouteLayer))
    try {
      await handler(new Request("http://localhost/session/ses_x", { headers: { "user-agent": "miao-test/1" } }))
      await handler(new Request("http://localhost/api/session/ses_x"))
    } finally {
      await dispose()
    }
    expect(lines).toEqual([
      { level: "Warn", message: ["legacy-route", { route: "GET /session/:id", userAgent: "miao-test/1" }] },
    ])
  })
})
