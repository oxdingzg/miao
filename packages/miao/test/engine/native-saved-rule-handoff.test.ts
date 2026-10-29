import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { nativeHostSource } from "../fixture/native-host-source"

test.skipIf(!process.env.MIAO_ENGINE_BIN)(
  "native saved-rule handoff owns legacy grants after one import",
  async () => {
    await using fixture = await nativeHostSource()
    expect(fixture.supported.savedPermissionMigration).toBe(1)
    expect(await fixture.client.request("permission_saved_migration")).toBeNull()
    const input = {
      project: "legacy-project",
      rules: [{ id: "legacy-row", rule: { action: "read", resource: "public", effect: "allow" } }],
    }
    const receipt = await fixture.client.request("permission_saved_migrate", input)
    expect(receipt).toMatchObject({ project: "legacy-project", imported: 1 })
    expect(await fixture.client.request("permission_saved_imported")).toEqual(input.rules)
    expect(await fixture.client.request("permission_saved_migration")).toEqual(receipt)
    expect(await fixture.client.request("permission_saved_migrate", input)).toEqual(receipt)
    expect(await Effect.runPromise(fixture.permission.ask(fixture.request("imported", "public")))).toMatchObject({
      effect: "allow",
    })
    expect(fixture.asked).toHaveLength(0)
    expect(await Effect.runPromise(fixture.permission.ask(fixture.request("denied", "secret")))).toMatchObject({
      effect: "deny",
    })
    for (const removed of [true, false])
      expect(await fixture.client.request("permission_saved_remove", { id: "legacy-row" })).toEqual({ removed })
    expect(await fixture.client.request("permission_saved_migrate", input)).toEqual(receipt)
    expect(await fixture.client.request("permission_saved_imported")).toEqual([])
    await expect(
      fixture.client.request("permission_saved_project", {
        workspace: fixture.directory,
        rules: input.rules.map((item) => item.rule),
      }),
    ).rejects.toThrow()
    await expect(fixture.client.request("permission_saved_migrate", { ...input, project: "other" })).rejects.toThrow()
    await expect(
      fixture.client.request("permission_saved_migrate", { ...input, workspace: "/foreign" }),
    ).rejects.toThrow()
    const waiting = Effect.runFork(fixture.permission.assert(fixture.request("revoked", "public")))
    await fixture.reply(await fixture.wait("revoked"), "reject")
    expect((await Effect.runPromise(Fiber.await(waiting)))._tag).toBe("Failure")
    expect(fixture.asked).toHaveLength(1)
  },
  20_000,
)
