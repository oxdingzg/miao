import { expect, test } from "bun:test"
import { statusHintSegments } from "../../../src/component/status-line"

const text = (hint: Parameters<typeof statusHintSegments>[0]) =>
  statusHintSegments(hint)
    .map((item) => item.text)
    .join(" · ")

test("the status row reports the mode, background work and the next escape action", () => {
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 0 })).toBe("auto-approve off")
  expect(statusHintSegments({ permissionMode: "auto", runningJobs: 0, busy: false, waitingPrompts: 0 })[0]).toEqual({
    text: "auto-approve on",
    tone: "warning",
  })
  expect(text({ permissionMode: "normal", runningJobs: 1, busy: false, waitingPrompts: 0 })).toContain(
    "1 background job running",
  )
  expect(text({ permissionMode: "normal", runningJobs: 3, busy: false, waitingPrompts: 0 })).toContain(
    "3 background jobs running",
  )
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: true, waitingPrompts: 0 })).toContain("esc interrupt")
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: true, waitingPrompts: 2 })).toContain(
    "esc interrupt and send",
  )
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 2 })).toContain(
    "esc remove prompt",
  )
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 0 })).not.toContain("esc")
})

test("queued prompts are counted whether or not the session is busy", () => {
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 0 })).not.toContain("queued")
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: true, waitingPrompts: 1 })).toContain("queued (1)")
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 3 })).toContain("queued (3)")
  // A running turn is always the thing esc stops; the queued prompt is sent
  // once that turn ends, so the hint says so.
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: true, waitingPrompts: 2 })).toBe(
    "auto-approve off · queued (2) · esc interrupt and send",
  )
  // With nothing running, the queued prompt is the only thing left to take back.
  expect(text({ permissionMode: "normal", runningJobs: 0, busy: false, waitingPrompts: 2 })).toBe(
    "auto-approve off · queued (2) · esc remove prompt",
  )
})
