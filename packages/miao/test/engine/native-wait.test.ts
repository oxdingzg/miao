import { expect, test } from "bun:test"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { waitNative } from "@miao/server/native-session"
import { Effect } from "effect"

const sessionID = SessionID.make("ses_native_wait")
const placement = {
  storage: AbsolutePath.make("/tmp/native-wait.db"),
  location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
}
const run = "67bb9f66-f1f8-44c3-8418-e0f5e8d0ed61"

function reads(snapshots: Array<Record<string, unknown>>) {
  const seen: Array<Record<string, unknown>> = []
  let index = 0
  return {
    seen,
    native: {
      snapshot: (input: { metadataOnly?: boolean }) =>
        Effect.sync(() => {
          expect(input.metadataOnly).toBe(true)
          const snapshot = snapshots[Math.min(index++, snapshots.length - 1)]!
          seen.push(snapshot)
          return snapshot
        }),
    },
  }
}

test("a wait that lands between promotion and the run row does not report the turn as finished", async () => {
  const fake = reads([
    { active_run: null, pending: [] },
    { active_run: run, pending: [] },
    { active_run: run, pending: [] },
    { active_run: null, pending: [] },
    { active_run: null, pending: [] },
  ])
  await Effect.runPromise(waitNative({ native: fake.native, sessionID, ...placement }))
  // The first idle read is the engine's admission-to-run window; returning
  // there would abandon a turn that is about to start.
  expect(fake.seen).toHaveLength(5)
})

test("a genuinely idle Session settles on the confirming read", async () => {
  const fake = reads([{ active_run: null, pending: [] }])
  await Effect.runPromise(waitNative({ native: fake.native, sessionID, ...placement }))
  expect(fake.seen).toHaveLength(2)
})

test("an admitted input keeps the wait open until the engine promotes it", async () => {
  const fake = reads([
    { active_run: null, pending: [{ input_id: "msg_queued", delivery: "queue" }] },
    { active_run: null, pending: [] },
    { active_run: null, pending: [] },
  ])
  await Effect.runPromise(waitNative({ native: fake.native, sessionID, ...placement }))
  expect(fake.seen).toHaveLength(3)
})
