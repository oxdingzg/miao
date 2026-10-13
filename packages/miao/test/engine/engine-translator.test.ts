import { expect, test } from "bun:test"
import { EngineTranslator, type EngineSessionEvent } from "@/engine/session"

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
  expect(outputs).toHaveLength(1)
  expect(outputs[0].type).toBe("session.next.text.ended")
  expect(outputs[0].source).toEqual({ sessionID: "ses_replay", seq: 7, index: 0, recordedAtMs: 420 })
  const data = outputs[0].data as { text?: unknown }
  expect(data.text).toBe("persisted")
})

test("unrelated journal kinds produce no product events and engine vocabulary stays engine-side", () => {
  const { outputs, translator } = collect()
  translator.dispatch({ session_id: "ses_replay", seq: 8, kind: "context.changed", data: { epoch: 1 } })
  translator.dispatch({ session_id: "ses_replay", seq: 9, kind: "input.promoted", data: { input_id: "in_1" } })
  expect(outputs).toEqual([])
})
