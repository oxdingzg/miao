import { expect, test } from "bun:test"
import { EngineTranslator, type EngineSessionEvent } from "@/engine/session"
import { messageID } from "@/engine/identity"

const collect = () => {
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator((event) => outputs.push(event))
  return { outputs, translator }
}

test("journal replay translates committed assistant text with per-event provenance", () => {
  const { outputs, translator } = collect()
  translator.dispatch({
    session_id: "ses_replay",
    seq: 7,
    kind: "message.committed",
    data: { role: "assistant", content: [{ type: "text", text: "persisted" }] },
    recorded_at_ms: 420,
  })
  expect(outputs).toHaveLength(2)
  expect(outputs[0].type).toBe("session.next.text.ended")
  expect(outputs[0].source).toEqual({ sessionID: "ses_replay", seq: 7, index: 0, recordedAtMs: 420 })
  const data = outputs[0].data as { text?: unknown }
  expect(data.text).toBe("persisted")
  // The assistant settlement trails its own text events and carries the
  // step's usage evidence (zeroed when the journal recorded no usage).
  expect(outputs[1].type).toBe("session.next.step.ended")
  expect(outputs[1].source).toEqual({ sessionID: "ses_replay", seq: 7, index: 0, recordedAtMs: 420 })
  const settlement = outputs[1].data as {
    assistantMessageID?: unknown
    finish?: unknown
    cost?: unknown
    tokens?: { input?: unknown }
    ttft?: unknown
  }
  expect(settlement.assistantMessageID).toBe(messageID("ses_replay", 7))
  expect(settlement.finish).toBe("stop")
  expect(settlement.cost).toBe(0)
  expect(settlement.tokens?.input).toBe(0)
  expect(settlement.ttft).toBeUndefined()
})

test("unrelated journal kinds produce no product events and engine vocabulary stays engine-side", () => {
  const { outputs, translator } = collect()
  translator.dispatch({ session_id: "ses_replay", seq: 8, kind: "context.changed", data: { epoch: 1 } })
  translator.dispatch({ session_id: "ses_replay", seq: 9, kind: "input.promoted", data: { input_id: "in_1" } })
  expect(outputs).toEqual([])
})
