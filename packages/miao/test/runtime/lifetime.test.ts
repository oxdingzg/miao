import { expect, test } from "bun:test"
import { RuntimeLifetime } from "../../src/runtime/lifetime"

test("lingerMs reads the runtime.lingerMs contract", () => {
  // Absent or unparsable stays with the lightweight default: exit when the last
  // client disconnects and nothing else is active.
  expect(RuntimeLifetime.lingerMs(undefined)).toBe(0)
  expect(RuntimeLifetime.lingerMs("")).toBe(0)
  expect(RuntimeLifetime.lingerMs("nonsense")).toBe(0)
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

test("startupGraceMs protects a just-spawned Runtime and reads the env switch", () => {
  expect(RuntimeLifetime.startupGraceMs(undefined)).toBe(60_000)
  expect(RuntimeLifetime.startupGraceMs("")).toBe(60_000)
  expect(RuntimeLifetime.startupGraceMs("nonsense")).toBe(60_000)
  expect(RuntimeLifetime.startupGraceMs("0")).toBe(0)
  expect(RuntimeLifetime.startupGraceMs("5000")).toBe(5000)
  // A negative grace would disable the guard, so it falls back to the default.
  expect(RuntimeLifetime.startupGraceMs("-1")).toBe(60_000)
})
