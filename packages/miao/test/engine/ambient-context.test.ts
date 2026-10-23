import { expect, test } from "bun:test"
import { contextDirectoryName } from "../../src/engine/ambient-context"

test("the native context directory name is a pure function of the bundle identity", () => {
  const identity = JSON.stringify([["skill", "content"], ["dir"], [true, true, true]])
  const same = contextDirectoryName(JSON.stringify([["skill", "content"], ["dir"], [true, true, true]]))
  const changed = contextDirectoryName(JSON.stringify([["skill", "changed"], ["dir"], [true, true, true]]))
  expect(same).toBe(contextDirectoryName(identity))
  expect(changed).not.toBe(same)
  expect(same).toContain("miao-native-context-")
})
