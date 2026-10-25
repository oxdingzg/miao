import { expect, test } from "bun:test"
import {
  adoptSession,
  generatedInputEngineID,
  generatedInputMessageID,
  messageID,
  promotedInputMessageID,
} from "@/engine/identity"

test("adopts the engine session id 1:1", () => {
  expect(String(adoptSession("ses_abc"))).toBe("ses_abc")
})

test("a generated input's product identity round-trips to the engine id", () => {
  for (const engineInputID of [
    "monitor:8ffca768-5f2a-4cea-a62a-1d1688529fdf:d3a3e670-4240-472b-8fb7-ca5672ea0f2c",
    "wakeup/sched_1",
    "job:abc:finished",
    "seed",
  ]) {
    const id = generatedInputMessageID(engineInputID)
    expect(String(id)).toStartWith("msg_gen_")
    expect(generatedInputEngineID(String(id))).toBe(engineInputID)
    // The promotion event carries the same engine id, so it projects the same
    // product identity the inbox read did.
    expect(String(promotedInputMessageID(engineInputID))).toBe(String(id))
  }
})

test("a submitted prompt id is not re-derived", () => {
  expect(String(promotedInputMessageID("msg_user_submitted"))).toBe("msg_user_submitted")
  expect(generatedInputEngineID("msg_user_submitted")).toBeUndefined()
})

test("only a canonical generated identity decodes", () => {
  expect(generatedInputEngineID("msg_gen_")).toBeUndefined()
  expect(generatedInputEngineID("msg_gen_!!!!")).toBeUndefined()
  // A non-canonical trailing-padding variant is not an identity this module made.
  expect(generatedInputEngineID("msg_gen_c2VlZA==")).toBeUndefined()
  expect(generatedInputEngineID("msg_ses_abc_3")).toBeUndefined()
})

test("message ids are deterministic and distinct per seq", () => {
  const id = String(messageID("ses_abc", 3))
  expect(id).toBe("msg_ses_abc_3")
  expect(String(messageID("ses_abc", 3))).toBe(id)
  expect(String(messageID("ses_abc", 4))).not.toBe(id)
})
