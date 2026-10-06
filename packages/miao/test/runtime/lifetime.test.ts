import { expect, test } from "bun:test"
import { RuntimeLifetime } from "../../src/runtime/lifetime"

test("lingerMs reads the runtime.lingerMs contract", () => {
  // Absent or unparsable stays with the default warm window.
  expect(RuntimeLifetime.lingerMs(undefined)).toBe(5 * 60 * 1000)
  expect(RuntimeLifetime.lingerMs("")).toBe(5 * 60 * 1000)
  expect(RuntimeLifetime.lingerMs("nonsense")).toBe(5 * 60 * 1000)
  // 0 follows the last client, a positive value is a grace window, and any
  // negative value means never exit automatically.
  expect(RuntimeLifetime.lingerMs("0")).toBe(0)
  expect(RuntimeLifetime.lingerMs("1500")).toBe(1500)
  expect(RuntimeLifetime.lingerMs("-1")).toBe(-1)
  expect(RuntimeLifetime.lingerMs("-5000")).toBe(-1)
})

test("remoteControlPins defaults on and reads the env switch", () => {
  expect(RuntimeLifetime.remoteControlPins(undefined)).toBe(true)
  expect(RuntimeLifetime.remoteControlPins("")).toBe(true)
  expect(RuntimeLifetime.remoteControlPins("true")).toBe(true)
  expect(RuntimeLifetime.remoteControlPins("0")).toBe(false)
  expect(RuntimeLifetime.remoteControlPins("false")).toBe(false)
  expect(RuntimeLifetime.remoteControlPins("off")).toBe(false)
})
