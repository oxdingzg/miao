import { describe, expect, test } from "bun:test"
import type { SessionStatus, Todo } from "@miao/schema/view-models"
import type { SessionMessageInfo } from "@miao/session-ui/content"
import type { PermissionV2Request, QuestionRequest } from "@miao/schema/view-models"
import type { FileDiffInfo } from "@/utils/server"
import { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

const msg = (id: string, sessionID: string): SessionMessageInfo =>
  ({
    id,
    type: "user",
    time: { created: 1 },
    text: id,
  }) as SessionMessageInfo

describe("app session cache", () => {
  test("dropSessionCaches clears orphaned message state", () => {
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, FileDiffInfo[] | undefined>
      todo: Record<string, Todo[] | undefined>
      message: Record<string, SessionMessageInfo[] | undefined>
      permission: Record<string, PermissionV2Request[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
    } = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      session_diff: { ses_1: [] },
      todo: { ses_1: [] as Todo[] },
      message: {},
      permission: { ses_1: [] as PermissionV2Request[] },
      question: { ses_1: [] as QuestionRequest[] },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears message-backed state", () => {
    const m = msg("msg_1", "ses_1")
    const store: {
      session_status: Record<string, SessionStatus | undefined>
      session_diff: Record<string, FileDiffInfo[] | undefined>
      todo: Record<string, Todo[] | undefined>
      message: Record<string, SessionMessageInfo[] | undefined>
      permission: Record<string, PermissionV2Request[] | undefined>
      question: Record<string, QuestionRequest[] | undefined>
    } = {
      session_status: {},
      session_diff: {},
      todo: {},
      message: { ses_1: [m] },
      permission: {},
      question: {},
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
  })

  test("pickSessionCacheEvictions preserves requested sessions", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])

    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 1,
    })

    expect(stale).toEqual(["ses_1", "ses_2", "ses_3"])
  })
})
