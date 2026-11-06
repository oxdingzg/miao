import { describe, expect, test } from "bun:test"
import { RuntimeControlMethods } from "../../src/remote-control/control-methods"

type Session = { id: string; title: string; projectID: string }

const sessions: Record<string, Session> = {
  "session-a": { id: "session-a", title: "Fix the parser", projectID: "project-one" },
  "session-b": { id: "session-b", title: "Ship the inbox", projectID: "project-one" },
  "session-c": { id: "session-c", title: "Other repo", projectID: "project-two" },
}

const permissions: Record<string, Array<{ id: string; sessionID: string; action: string; resources: string[] }>> = {
  "session-a": [{ id: "per_1", sessionID: "session-a", action: "bash: rm -rf build", resources: ["build"] }],
}

const questions: Record<string, Array<{ id: string; sessionID: string; questions: Array<{ question: string }> }>> = {
  "session-b": [
    { id: "que_1", sessionID: "session-b", questions: [{ question: "Which database?" }] },
  ],
}

function fixtures(input: { projectIDs: string[]; sessionIDs?: string[]; owned?: string[] }) {
  const listed: string[] = []
  const fetched: string[] = []
  const client = {
    sessions: {
      list: async (request: { project: string }) => {
        listed.push(request.project)
        return { data: Object.values(sessions).filter((session) => session.projectID === request.project) }
      },
      get: async (request: { sessionID: string }) => {
        fetched.push(request.sessionID)
        const session = sessions[request.sessionID]
        if (!session) throw new Error("SessionNotFoundError")
        return session
      },
    },
    permissions: { list: async (request: { sessionID: string }) => permissions[request.sessionID] ?? [] },
    questions: { list: async (request: { sessionID: string }) => questions[request.sessionID] ?? [] },
  }
  const methods = RuntimeControlMethods.make({
    owned: async (sessionID) => (input.owned ?? Object.keys(sessions)).includes(sessionID),
    client: client as never,
    run: () => {
      throw new Error("pending.list must not touch the database")
    },
  })
  const context = {
    grant: {
      id: "grant",
      version: 1,
      publicKey: "key",
      label: "phone",
      permissions: ["read"],
      projectIDs: input.projectIDs,
      sessionIDs: input.sessionIDs ?? [],
      expiresAt: Date.now() + 60_000,
      revokedAt: null,
    },
    signal: new AbortController().signal,
    authorize: () => undefined,
  }
  const request = { method: "pending.list", payload: {} }
  return { methods, context, request, listed, fetched }
}

type Result = {
  data: Array<{
    sessionID: string
    title: string
    permissions: Array<{ action: string }>
    questions: Array<{ text: string }>
  }>
}

describe("pending.list", () => {
  test("collects only Sessions that wait inside the grant scope", async () => {
    const f = fixtures({ projectIDs: ["project-one"] })
    const result = (await f.methods["pending.list"]!(f.request as never, f.context as never)) as Result

    expect(f.listed).toEqual(["project-one"])
    expect(result.data.map((entry) => entry.sessionID)).toEqual(["session-a", "session-b"])
    expect(result.data[0].title).toBe("Fix the parser")
    expect(result.data[0].permissions[0].action).toBe("bash: rm -rf build")
    expect(result.data[1].questions[0].text).toBe("Which database?")
    // A Session with nothing waiting is not reported at all.
    expect(result.data.some((entry) => entry.sessionID === "session-c")).toBe(false)
  })

  test("drops a Session this window does not own even when the project lists it", async () => {
    const f = fixtures({ projectIDs: ["project-one"], owned: ["session-b"] })
    const result = (await f.methods["pending.list"]!(f.request as never, f.context as never)) as Result

    expect(result.data.map((entry) => entry.sessionID)).toEqual(["session-b"])
  })

  test("a Session-only grant reads its own Sessions instead of enumerating the project", async () => {
    const f = fixtures({ projectIDs: [], sessionIDs: ["session-a"] })
    const result = (await f.methods["pending.list"]!(f.request as never, f.context as never)) as Result

    expect(f.listed).toEqual([])
    expect(f.fetched).toEqual(["session-a"])
    expect(result.data.map((entry) => entry.sessionID)).toEqual(["session-a"])
  })

  test("a grant with no scope reports nothing", async () => {
    const f = fixtures({ projectIDs: [], sessionIDs: [] })
    const result = (await f.methods["pending.list"]!(f.request as never, f.context as never)) as Result

    expect(result.data).toEqual([])
  })
})
