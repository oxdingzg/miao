import { describe, expect, it } from "bun:test"
import { CallMeta } from "@/mcp/call-meta"

function fakeClient() {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    callTool: async (params: Record<string, unknown>) => {
      calls.push(params)
      return {}
    },
  }
  return { calls, client }
}

const IDENTITY = "com.example/identity"

describe("CallMeta", () => {
  it("re-reads {env:VAR} on every call, so rotation is picked up", async () => {
    process.env.MIAO_CALL_META_TOKEN = "one"
    const { calls, client } = fakeClient()
    CallMeta.wrap(client as never, { [IDENTITY]: "Bearer {env:MIAO_CALL_META_TOKEN}" })
    await (client as { callTool: (p: object) => Promise<unknown> }).callTool({ name: "t" })
    await (client as { callTool: (p: object) => Promise<unknown> }).callTool({ name: "t" })
    process.env.MIAO_CALL_META_TOKEN = "two"
    await (client as { callTool: (p: object) => Promise<unknown> }).callTool({ name: "t" })
    expect(calls.map((call) => (call._meta as Record<string, string>)[IDENTITY])).toEqual([
      "Bearer one",
      "Bearer one",
      "Bearer two",
    ])
    delete process.env.MIAO_CALL_META_TOKEN
  })

  it("configured keys win over caller _meta; caller keys pass through", async () => {
    const { calls, client } = fakeClient()
    CallMeta.wrap(client as never, { [IDENTITY]: "host" })
    await (client as { callTool: (p: object) => Promise<unknown> }).callTool({
      name: "t",
      _meta: { [IDENTITY]: "caller", trace: "abc" },
    })
    expect(calls[0]?.name).toBe("t")
    expect(calls[0]?._meta).toEqual({ [IDENTITY]: "host", trace: "abc" })
  })

  it("leaves the client untouched without a spec", async () => {
    const { client } = fakeClient()
    const original = client.callTool
    CallMeta.wrap(client as never, undefined)
    expect(client.callTool).toBe(original)
    CallMeta.wrap(client as never, {})
    expect(client.callTool).toBe(original)
  })
})
