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

test("formats the host-provided continuation command", () => {
  expect(
    sessionEpilogue({ title: "Preview session", sessionID: "ses_preview", resumeCommand: "/preview/build/miao" }),
  ).toContain("/preview/build/miao -s ses_preview")
})
