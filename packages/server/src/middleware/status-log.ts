import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

// Defect-caused 500s are logged by the error middleware, but typed errors and
// upstream layers can produce 5xx responses that reach the client with no log
// at all — observed live: TUI clients crashed on 500s that had no server-side
// trace. Log every 5xx response with its method and path so the route is at
// least identifiable after the fact.
export const statusLogLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    if (response.status < 500) return response
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* Effect.logWarning("http.5xx", {
      method: request.method,
      path: request.url,
      status: response.status,
    })
    return response
  }),
  { global: true },
).layer
