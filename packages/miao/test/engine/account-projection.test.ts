import { expect, test } from "bun:test"
import { EngineTranslator, type EngineSessionEvent } from "../../src/engine/session"

test("account intent has its own replay identity and model-only events do not fabricate it", () => {
  const events: EngineSessionEvent[] = []
  const translator = new EngineTranslator((event) => events.push(event))
  translator.dispatch({
    session_id: "ses_account",
    seq: 1,
    kind: "session.model.selected",
    recorded_at_ms: 1000,
    data: { binding: null },
  })
  expect(events).toHaveLength(0)
  translator.dispatch({
    session_id: "ses_account",
    seq: 2,
    kind: "session.account.selected",
    recorded_at_ms: 1001,
    data: { account: { credential_id: "cred_second" } },
  })
  expect(events[0].type).toBe("session.next.account.switched")
  expect(events[0].data).toMatchObject({ credentialID: "cred_second", messageID: "msg_ses_account_2" })
  expect(events[0].source).toMatchObject({ sessionID: "ses_account", seq: 2, index: 0 })
  translator.dispatch({
    session_id: "ses_account",
    seq: 3,
    kind: "session.account.selected",
    recorded_at_ms: 1002,
    data: { account: null },
  })
  expect(events[1].data).toMatchObject({ credentialID: null, messageID: "msg_ses_account_3" })
})
