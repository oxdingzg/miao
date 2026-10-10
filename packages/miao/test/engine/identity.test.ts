import { expect, test } from "bun:test"
import { adoptSession, messageID } from "@/engine/identity"

test("adopts the engine session id 1:1", () => {
  expect(String(adoptSession("ses_abc"))).toBe("ses_abc")
})

test("message ids are deterministic and distinct per seq", () => {
  const id = String(messageID("ses_abc", 3))
  expect(id).toBe("msg_ses_abc_3")
  expect(String(messageID("ses_abc", 3))).toBe(id)
  expect(String(messageID("ses_abc", 4))).not.toBe(id)
})
