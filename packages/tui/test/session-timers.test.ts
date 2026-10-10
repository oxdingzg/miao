import { expect, test } from "bun:test"
import type { SessionsActivityOutput } from "@miao/client"
import { sessionTimerRows } from "../src/util/session-timers"

const activity: SessionsActivityOutput = {
  observedAt: 1000,
  status: { type: "idle" },
  pendingNotifications: 0,
  schedules: [{ id: "sched_1", prompt: "Check CI", createdAt: 1000, nextAt: 181000, recurring: false }],
  jobs: [],
}

test("countdown advances while an idle session waits, then shows due without claiming execution", () => {
  expect(sessionTimerRows(activity, 1000)[0].text).toBe("Wakeup in 3m 0s · waited 0s")
  expect(sessionTimerRows(activity, 61000)[0].text).toBe("Wakeup in 2m 0s · waited 1m 0s")
  expect(sessionTimerRows(activity, 190000)[0].text).toBe("Wakeup due · waiting for scheduler · waited 3m 9s")
})

test("admitted notices show queued state after a one-shot schedule is removed", () => {
  const queued = { ...activity, schedules: [], pendingNotifications: 1 }
  expect(sessionTimerRows(queued, 190000)[0].text).toContain("queued · waiting for session boundary")
  expect(sessionTimerRows({ ...queued, pendingNotifications: 0 }, 200000)).toEqual([])
})

test("job timer starts from launch, freezes at completion and retires the completion notice", () => {
  const running = {
    ...activity,
    schedules: [],
    jobs: [{ id: "job_1", title: "gh run watch", status: "running" as const, startedAt: 1000 }],
  }
  expect(sessionTimerRows(running, 121000)[0].text).toBe("Running 2m 0s · gh run watch")
  const finished = { ...running, jobs: [{ ...running.jobs[0], status: "completed" as const, completedAt: 121000 }] }
  expect(sessionTimerRows(finished, 140000)[0].text).toBe("Finished 2m 0s · gh run watch")
  expect(sessionTimerRows(finished, 151000)).toEqual([])
})

test("untracked jobs report unknown outcomes rather than an ever-increasing runtime", () => {
  const lost = {
    ...activity,
    schedules: [],
    jobs: [{ id: "job_1", status: "error" as const, startedAt: 1000, error: "unknown outcome" }],
  }
  expect(sessionTimerRows(lost, 1000000)).toEqual([
    { id: "unknown", color: "warning", text: "Background job untracked · outcome unknown; it was not restarted" },
  ])
})
