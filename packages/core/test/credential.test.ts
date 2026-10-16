import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Credential } from "@miao/core/credential"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Integration } from "@miao/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

const key = (secret: string) => Credential.Key.make({ type: "key", key: secret })

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({ integrationID, label: "Work", value: key("secret") })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      yield* credentials.remove(created.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("a new account becomes the active one and keeps the previous rows", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const work = yield* credentials.create({ integrationID, label: "Work", value: key("work") })
      const personal = yield* credentials.create({ integrationID, label: "Personal", value: key("personal") })

      expect((yield* credentials.list(integrationID)).map((row) => [row.id, row.active])).toEqual([
        [work.id, false],
        [personal.id, true],
      ])
    }),
  )

  it.effect("re-authenticating the same method and label replaces the row instead of stacking", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const first = yield* credentials.create({ integrationID, value: key("first") })
      const second = yield* credentials.create({ integrationID, value: key("second") })

      expect(yield* credentials.list(integrationID)).toEqual([second])
      expect(second.id).toBe(first.id)
      expect(second.value).toEqual(key("second"))
    }),
  )

  it.effect("different labels or methods stack separate accounts", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const work = yield* credentials.create({ integrationID, label: "Work", value: key("work") })
      const personal = yield* credentials.create({ integrationID, label: "Personal", value: key("personal") })
      const methodID = Integration.MethodID.make("chatgpt-headless")
      const other = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 3_600_000,
        }),
      })

      expect((yield* credentials.list(integrationID)).map((credential) => credential.id)).toEqual([
        work.id,
        personal.id,
        other.id,
      ])
      expect(other.active).toBe(true)
    }),
  )

  it.effect("activate switches the active account for the integration", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const work = yield* credentials.create({ integrationID, label: "Work", value: key("work") })
      const personal = yield* credentials.create({ integrationID, label: "Personal", value: key("personal") })

      yield* credentials.activate(work.id)
      expect((yield* credentials.list(integrationID)).map((row) => [row.id, row.active])).toEqual([
        [personal.id, false],
        [work.id, true],
      ])
    }),
  )

  it.effect("removing the active credential promotes the newest remaining one", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const work = yield* credentials.create({ integrationID, label: "Work", value: key("work") })
      const personal = yield* credentials.create({ integrationID, label: "Personal", value: key("personal") })

      yield* credentials.remove(personal.id)
      expect((yield* credentials.list(integrationID)).map((row) => [row.id, row.active])).toEqual([[work.id, true]])
    }),
  )

  it.effect("removing an inactive credential keeps the active promotion untouched", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const work = yield* credentials.create({ integrationID, label: "Work", value: key("work") })
      const personal = yield* credentials.create({ integrationID, label: "Personal", value: key("personal") })

      yield* credentials.remove(work.id)
      expect(yield* credentials.list(integrationID)).toEqual([personal])
    }),
  )

  it.effect("lists sort inactive rows before the active one", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const first = yield* credentials.create({ integrationID, label: "First", value: key("first") })
      const second = yield* credentials.create({ integrationID, label: "Second", value: key("second") })
      const third = yield* credentials.create({ integrationID, label: "Third", value: key("third") })

      expect((yield* credentials.list(integrationID)).map((credential) => credential.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ])
      yield* credentials.activate(first.id)
      expect((yield* credentials.list(integrationID)).map((credential) => credential.id)).toEqual([
        second.id,
        third.id,
        first.id,
      ])
    }),
  )

  it.effect("refuses to replace or activate a daemon-owned credential", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt-headless")
      const owned = Credential.OAuth.make({
        type: "oauth",
        methodID,
        access: "stale",
        refresh: "old",
        expires: 1,
        metadata: { miaoCredentialSocket: "/unused/owner.sock" },
      })
      const daemonRow = yield* credentials.create({ integrationID, value: owned })
      expect(Exit.isFailure(yield* credentials.create({ integrationID, value: key("replacement") }).pipe(Effect.exit)))
        .toBe(true)
      expect(Exit.isFailure(yield* credentials.activate(daemonRow.id).pipe(Effect.exit))).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([daemonRow])
    }),
  )
})
