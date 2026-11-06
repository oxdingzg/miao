import { describe, expect, test } from "bun:test"
import { RuntimeControlMethods } from "../../src/remote-control/control-methods"

function fixtures(input: { running?: boolean; executionThrows?: boolean } = {}) {
  const calls: Array<{ method: string; input: unknown }> = []
  const client = {
    sessions: {
      list: async (request: unknown, _options: unknown) => {
        calls.push({ method: "list", input: request })
        return { data: [], cursor: { next: null } }
      },
      pin: async (request: unknown) => {
        calls.push({ method: "pin", input: request })
      },
      archive: async (request: unknown) => {
        calls.push({ method: "archive", input: request })
      },
      remove: async (request: unknown) => {
        calls.push({ method: "remove", input: request })
      },
      execution: async (request: unknown) => {
        calls.push({ method: "execution", input: request })
        if (input.executionThrows) throw new Error("engine unavailable")
        return input.running ? { type: "running", executionID: "exec_1" } : { type: "idle" }
      },
      get: async () => undefined,
    },
    permissions: { list: async () => [] },
    questions: { list: async () => [] },
  }
  const methods = RuntimeControlMethods.make({
    owned: async () => true,
    client: client as never,
    // The receipt store is the only dependency these handlers need from the
    // database, and every action below is driven through it exactly once.
    run: (async () => ({ type: "prepared" })) as never,
  })
  const context = {
    grant: {
      id: "grant",
      version: 1,
      publicKey: "key",
      label: "phone",
      permissions: ["read", "session.rename", "session.delete"],
      projectIDs: ["project-one"],
      sessionIDs: [],
      expiresAt: Date.now() + 60_000,
      revokedAt: null,
    },
    signal: new AbortController().signal,
    authorize: () => undefined,
  }
  const request = (method: string, payload: unknown = {}) => ({
    method,
    sessionID: "session-a",
    operationID: crypto.randomUUID(),
    payload,
  })
  return { methods, context, request, calls }
}

describe("session management", () => {
  test("refuses to delete a Session that is still running", async () => {
    const f = fixtures({ running: true })
    const result = (await f.methods["session.remove"]!(
      f.request("session.remove") as never,
      f.context as never,
    )) as { status: string; code?: string }

    expect(result).toMatchObject({ status: "rejected", code: "conflict" })
    expect(f.calls.some((call) => call.method === "remove")).toBe(false)
  })

  test("deletes an idle Session", async () => {
    const f = fixtures({ running: false })
    const result = (await f.methods["session.remove"]!(
      f.request("session.remove") as never,
      f.context as never,
    )) as { status: string }

    expect(result).toEqual({ status: "completed" })
    expect(f.calls.filter((call) => call.method === "remove")).toHaveLength(1)
  })

  test("reports an unknown outcome when the execution probe fails", async () => {
    const f = fixtures({ executionThrows: true })
    const result = (await f.methods["session.remove"]!(
      f.request("session.remove") as never,
      f.context as never,
    )) as { status: string }

    // An unverifiable Session is never deleted.
    expect(result).toEqual({ status: "outcome_unknown" })
    expect(f.calls.some((call) => call.method === "remove")).toBe(false)
  })

  test("passes a pin through to the Session", async () => {
    const f = fixtures()
    const result = (await f.methods["session.pin"]!(
      f.request("session.pin", { pinned: true }) as never,
      f.context as never,
    )) as { status: string }

    expect(result).toEqual({ status: "completed" })
    expect(f.calls.find((call) => call.method === "pin")?.input).toEqual({ sessionID: "session-a", pinned: true })
  })
  test("passes an archive flag through to the Session", async () => {
    const f = fixtures()
    const result = (await f.methods["session.archive"]!(
      f.request("session.archive", { archived: false }) as never,
      f.context as never,
    )) as { status: string }

    expect(result).toEqual({ status: "completed" })
    expect(f.calls.find((call) => call.method === "archive")?.input).toEqual({
      sessionID: "session-a",
      archived: false,
    })
  })

  test("forwards a search term to the host instead of filtering locally", async () => {
    const f = fixtures()
    await f.methods["session.list"]!(
      { method: "session.list", projectID: "project-one", payload: { search: "parser", limit: 10 } } as never,
      f.context as never,
    )

    expect(f.calls.find((call) => call.method === "list")?.input).toEqual({
      project: "project-one",
      limit: 10,
      cursor: undefined,
      search: "parser",
    })
  })
})
