import { expect, test } from "bun:test"
import { loginTarget } from "../../src/cli/cmd/providers"

test("positional Zen and Go provider names use provider selection, not URL metadata fetching", () => {
  expect(loginTarget("opencode")).toEqual({ provider: "opencode", url: undefined })
  expect(loginTarget("opencode-go")).toEqual({ provider: "opencode-go", url: undefined })
  expect(loginTarget("OpenCode Zen")).toEqual({ provider: "OpenCode Zen", url: undefined })
})

test("HTTP auth-provider URLs keep the metadata flow and skip project bootstrap", () => {
  expect(loginTarget("https://auth.example.com///")).toEqual({ url: "https://auth.example.com", provider: undefined })
  expect(loginTarget()).toEqual({ url: undefined, provider: undefined })
})
