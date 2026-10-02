import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

/**
 * The V1 session routes retire once nothing calls them. Every hit logs
 * `level=WARN message=legacy-route` with the route and the caller's user agent,
 * so a soak period can show the count reaching zero before they are removed.
 */
export const legacyRouteLayer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const route = legacyRoute(request.method, new URL(request.url, "http://localhost").pathname)
      if (route) yield* Effect.logWarning("legacy-route", { route, userAgent: request.headers["user-agent"] ?? "" })
      return yield* effect
    }),
  { global: true },
)

const LEGACY = /^\/(session|permission|question|sync)(\/|$)|^\/experimental\/session(\/|$)/
// Session, message, part, permission and question IDs; collapsing them keeps one log key per route.
const ID = /^(ses|msg|prt|per|que|evt|wrk)_[A-Za-z0-9]+$/

/** `METHOD /path` with IDs collapsed, for a V1 session-family route; otherwise undefined. */
export function legacyRoute(method: string, pathname: string) {
  if (!LEGACY.test(pathname)) return
  return `${method} ${pathname
    .split("/")
    .map((segment) => (ID.test(segment) ? ":id" : segment))
    .join("/")}`
}
