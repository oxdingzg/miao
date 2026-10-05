import { expect, test } from "bun:test"
import { sessionPhaseLabelKey } from "./session-status-label"

test("maps a drain phase to the waiting label", () => {
  expect(sessionPhaseLabelKey(undefined)).toBe("ui.sessionTurn.status.thinking")
  expect(sessionPhaseLabelKey("queued")).toBe("ui.message.queued")
  expect(sessionPhaseLabelKey("preparing")).toBe("ui.sessionTurn.status.preparingRequest")
  expect(sessionPhaseLabelKey("requesting")).toBe("ui.sessionTurn.status.waitingForModel")
  expect(sessionPhaseLabelKey("streaming")).toBe("ui.sessionTurn.status.thinking")
  expect(sessionPhaseLabelKey("retrying")).toBe("ui.sessionTurn.status.thinking")
})
