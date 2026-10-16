import { expect, test } from "bun:test"
import { EngineTrace } from "@/blackbox/engine-trace"
import type { EngineEvent } from "@/engine/client"

function request(route: string, account: string, system = "system", extra = "stable"): EngineEvent {
  return {
    session_id: "s",
    seq: 1,
    kind: "provider.request",
    recorded_at_ms: 1,
    data: {
      cache_diagnostics: {
        version: 1,
        snapshot: { routeHash: route, accountHash: account, systemHash: system, unknown: extra },
        changes: [],
      },
    },
  }
}

test("cache trace renames observation identities while retaining semantic prefix evidence", () => {
  const record = new EngineTrace()
  const replay = new EngineTrace()
  expect(record.project(request("record-port", "account-a"))).toEqual(
    replay.project(request("replay-port", "fixture-account")),
  )
  expect(record.project(request("record-port", "account-a"))).not.toEqual(
    replay.project(request("replay-port", "fixture-account", "changed-system")),
  )
  expect(record.project(request("record-port", "account-a"))).not.toEqual(
    replay.project(request("replay-port", "fixture-account", "system", "changed-unknown-field")),
  )
  expect(record.project(request("different-route", "account-a"))).not.toEqual(
    replay.project(request("replay-port", "fixture-account")),
  )
})
