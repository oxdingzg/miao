import { expect, test } from "bun:test"
import { Dynamic, isServer } from "solid-js/web"

// The test scripts must resolve solid-js/web to the client build (web.js),
// which the components under test were built for. The SSR build answers
// `isServer` with true and lacks client-only exports such as `use`, so this
// suite fails the moment that resolution regresses. The test scripts must pass
// `--conditions=browser` as repeated flags: bun reads
// `--conditions=browser,solid` as a single unknown condition name and silently
// keeps the node/SSR resolution.
test("the test environment resolves solid-js/web to the client build", () => {
  expect(isServer).toBe(false)
  expect(typeof Dynamic).toBe("function")
})
