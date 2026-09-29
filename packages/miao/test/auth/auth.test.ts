import { describe, expect } from "bun:test"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@miao/core/global"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("set keeps entries this build cannot decode", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const file = path.join(Global.Path.data, "auth.json")
      yield* Effect.promise(() =>
        fs.writeFile(file, JSON.stringify({ legacy: { type: "mystery", value: "keep-me" } }), "utf8"),
      )
      // `all()` filters out the undecodable entry, so callers cannot see it…
      expect((yield* auth.all())["legacy"]).toBeUndefined()
      // …but writing an unrelated key must not erase it from disk.
      yield* auth.set("anthropic", { type: "api", key: "sk-test" })
      const raw = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
      expect(raw.legacy).toEqual({ type: "mystery", value: "keep-me" })
      expect(raw.anthropic).toEqual({ type: "api", key: "sk-test" })
    }),
  )
})
