import { describe, expect, test } from "bun:test"
import { fetchSessionExport, sessionExportFilename } from "./session-export"
import type { MessageListInput, SessionInfo, SessionMessageInfo } from "@opencode-ai/client/promise"

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

const session: SessionInfo = {
  id: "ses_1",
  parentID: "ses_0",
  projectID: "prj_1",
  cost: 0.5,
  tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 1, write: 2 } },
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  title: "Test Session",
  location: { directory: "/repo/packages/app" },
  subpath: "packages/app",
}

const user = (id: string): SessionMessageInfo => ({
  id,
  time: { created: 1_700_000_000_000 },
  text: `hello ${id}`,
  type: "user",
})

describe("fetchSessionExport", () => {
  test("builds a version 2 archive from the V2 session and message pages", async () => {
    const pages = [
      Array.from({ length: 200 }, (_, index) => user(`msg_${String(index).padStart(3, "0")}`)),
      [user("msg_200")],
    ]
    const requests: MessageListInput[] = []
    const api = {
      session: { get: async () => session },
      message: {
        list: async (input: MessageListInput) => {
          requests.push(input)
          const index = input.cursor ? Number(input.cursor) : 0
          return { data: pages[index], cursor: { previous: null, next: String(index + 1) } }
        },
      },
    }

    const result = await fetchSessionExport({ sessionID: "ses_1", api })

    expect(requests).toEqual([
      { sessionID: "ses_1", limit: 200, order: "asc" },
      { sessionID: "ses_1", limit: 200, cursor: "1" },
    ])
    expect(result).toEqual({
      version: 2,
      info: {
        id: "ses_1",
        slug: "ses_1",
        projectID: "prj_1",
        directory: "/repo/packages/app",
        path: "packages/app",
        parentID: "ses_0",
        title: "Test Session",
        version: "v2",
        cost: 0.5,
        tokens: session.tokens,
        time: session.time,
      },
      messages: [],
      projection: pages.flat(),
    })
  })

  test("stops paging when the history ends exactly on a full page", async () => {
    const pages = [Array.from({ length: 200 }, (_, index) => user(`msg_${index}`)), []]
    const api = {
      session: { get: async () => session },
      message: {
        list: async (input: MessageListInput) => {
          const index = input.cursor ? Number(input.cursor) : 0
          return { data: pages[index], cursor: { next: pages[index].length ? String(index + 1) : null } }
        },
      },
    }

    const result = await fetchSessionExport({ sessionID: "ses_1", api })

    expect(result.projection).toHaveLength(200)
  })

  test("rejects when the session is missing", async () => {
    const api = {
      session: {
        get: async (): Promise<SessionInfo> => {
          throw new Error("Session not found: ses_missing")
        },
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    }

    await expect(fetchSessionExport({ sessionID: "ses_missing", api })).rejects.toThrow(
      "Session not found: ses_missing",
    )
  })
})
