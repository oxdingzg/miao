import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("miao -s ses_123")
  // Cat + solid block MIAO wordmark.
  expect(epilogue).toContain("( o.o )")
  expect(epilogue).toContain("█   █")
})
