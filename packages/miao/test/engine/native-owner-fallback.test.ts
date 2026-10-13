import { expect, test } from "bun:test"
import { NativeEngine } from "@miao/server/native-engine"
import { requireTypescriptOwner } from "@miao/server/native-command"
import { AbsolutePath } from "@miao/schema/schema"
import { Effect } from "effect"

const placement = {
  storage: AbsolutePath.make("/tmp/engine.db"),
  location: { directory: AbsolutePath.make("/workspace") },
}

test("missing native placement permits the existing TS implementation", async () => {
  expect(await Effect.runPromise(requireTypescriptOwner("ses_ts", "session.shell"))).toBeUndefined()
})

test("unsupported native mutations fail before the TS writer can run", async () => {
  for (const operation of [
    "session.shell",
    "session.command",
    "session.compact",
    "session.switchModel",
    "session.revert.stage",
  ]) {
    const attempted: string[] = []
    const result = await Effect.runPromise(
      requireTypescriptOwner("ses_native", operation).pipe(
        Effect.andThen(Effect.sync(() => attempted.push("TS writer"))),
        Effect.provideService(NativeEngine.Placement, placement),
        Effect.flip,
      ),
    )
    expect(result._tag).toBe("ConflictError")
    expect(result.resource).toBe("ses_native")
    expect(result.message).toContain(operation)
    expect(attempted).toEqual([])
  }
})
