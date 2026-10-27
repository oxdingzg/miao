import { describe, expect, test } from "bun:test"
import { validateModel } from "../../../src/cli/tui/validate-model"

const directory = "/tmp/miao-validate-model"

// `/api/model` already answers "what can this location run", so the preflight
// only needs to read that list back.
function listing(models: ReadonlyArray<{ id: string; providerID: string }>) {
  return new Response(
    JSON.stringify({
      location: { directory, project: { id: "project", directory } },
      data: models,
    }),
    { headers: { "content-type": "application/json" } },
  )
}

describe("validateModel", () => {
  test("accepts a model the location offers", async () => {
    const requests: URL[] = []
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        model: "deepseek/deepseek-v4-pro",
        directory,
        fetch: (async (input: URL | RequestInfo) => {
          requests.push(new URL(input instanceof Request ? input.url : String(input)))
          return listing([{ id: "deepseek-v4-pro", providerID: "deepseek" }])
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined()
    expect(requests.map((url) => url.pathname)).toEqual(["/api/model"])
  })

  test("fails an explicit model the location does not offer", async () => {
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        model: "opencode/deepseek-v4-flash-free",
        directory,
        fetch: (async () => listing([{ id: "deepseek-v4-pro", providerID: "deepseek" }])) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Model not found: opencode/deepseek-v4-flash-free")
  })

  test("fails when the provider is missing even if the model id matches", async () => {
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        model: "opencode/deepseek-v4-pro",
        directory,
        fetch: (async () => listing([{ id: "deepseek-v4-pro", providerID: "deepseek" }])) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Model not found: opencode/deepseek-v4-pro")
  })

  test("fails a value without a provider separator", async () => {
    let called = false
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        model: "deepseek-v4-pro",
        directory,
        fetch: (async () => {
          called = true
          return listing([])
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Invalid model format: deepseek-v4-pro")
    expect(called).toBe(false)
  })

  test("does nothing without an explicit model", async () => {
    let called = false
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        directory,
        fetch: (async () => {
          called = true
          return listing([])
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  test("does not block startup when the catalog is unreadable", async () => {
    await expect(
      validateModel({
        url: "http://127.0.0.1:4096",
        model: "opencode/deepseek-v4-flash-free",
        directory,
        fetch: (async () => {
          throw new TypeError("fetch failed")
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined()
  })
})
