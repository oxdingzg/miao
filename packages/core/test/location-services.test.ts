import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { buildLocationServiceMap } from "@miao/core/location-services"
import { SessionAdmission } from "@miao/core/session/admission"

const admission = Layer.succeed(
  SessionAdmission.Service,
  SessionAdmission.Service.of({
    admit: () => Effect.die("unused"),
    cancel: () => Effect.succeed(false),
  }),
)

/**
 * The map is process-wide state. Two compositions describing the same graph must
 * share it: a second map gives one directory a second set of location services,
 * so a permission asked in one graph is invisible to a reply resolving the
 * other, and the tool call waiting on it never resumes.
 */
describe("buildLocationServiceMap", () => {
  it("shares one map for the same graph shape", () => {
    expect(buildLocationServiceMap([[SessionAdmission.node, admission]])).toBe(
      buildLocationServiceMap([[SessionAdmission.node, admission]]),
    )
  })

  it("keeps a map per distinct replacement", () => {
    expect(buildLocationServiceMap([[SessionAdmission.node, admission]])).not.toBe(buildLocationServiceMap())
  })
})
