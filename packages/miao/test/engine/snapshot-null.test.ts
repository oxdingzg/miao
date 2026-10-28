import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProductTools } from "@/engine/product-tools"

/**
 * The engine serialises `Option` as JSON `null`, so a session it has not
 * titled, or whose timestamp it has not recorded yet, arrives with those fields
 * set to null rather than absent. The decode used to reject that and the whole
 * tool call failed with it.
 */
const decode = Schema.decodeUnknownSync(ProductTools.Snapshot)

describe("the engine session snapshot", () => {
  test("accepts a session with no title or timestamp", () => {
    expect(() => decode({ title: null, updated_at_ms: null })).not.toThrow()
  })

  test("accepts an empty snapshot", () => {
    expect(() => decode({})).not.toThrow()
  })

  test("keeps fields the engine did set", () => {
    const snapshot = decode({ title: "Rename the config reader", updated_at_ms: 1_761_000_000_000 })
    expect(snapshot.title).toBe("Rename the config reader")
    expect(snapshot.updated_at_ms).toBe(1_761_000_000_000)
  })

  test("still rejects a title of the wrong type", () => {
    expect(() => decode({ title: 7 })).toThrow()
  })
})
