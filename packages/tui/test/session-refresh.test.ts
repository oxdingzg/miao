import { expect, test } from "bun:test"
import { createSessionRefreshScheduler } from "../src/context/session-refresh"

test("continuous deltas refresh before the stream becomes quiet", async () => {
  const calls: string[] = []
  const scheduler = createSessionRefreshScheduler({
    delay: 40,
    refresh: async (sessionID) => {
      calls.push(sessionID)
    },
    onError: (error) => {
      throw error
    },
  })
  try {
    // No gap reaches the refresh deadline. A trailing debounce never fires.
    for (let index = 0; index < 10; index++) {
      scheduler.schedule("session")
      await Bun.sleep(10)
    }
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((sessionID) => sessionID === "session")).toBe(true)
  } finally {
    scheduler.dispose()
  }
})

test("events arriving during a fetch coalesce into a fresh trailing snapshot", async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<void>()
  const refreshed = Promise.withResolvers<void>()
  let calls = 0
  let active = 0
  const scheduler = createSessionRefreshScheduler({
    delay: 10,
    refresh: async () => {
      calls++
      active++
      expect(active).toBe(1)
      if (calls === 1) {
        started.resolve()
        await response.promise
      }
      active--
      if (calls === 2) refreshed.resolve()
    },
    onError: refreshed.reject,
  })
  try {
    scheduler.schedule("session")
    await started.promise
    scheduler.schedule("session")
    scheduler.schedule("session")
    await Bun.sleep(30)
    expect(calls).toBe(1)
    response.resolve()
    await refreshed.promise
    await Bun.sleep(30)
    expect(calls).toBe(2)
  } finally {
    response.resolve()
    scheduler.dispose()
  }
})

test("different sessions refresh concurrently", async () => {
  const response = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const calls: string[] = []
  const scheduler = createSessionRefreshScheduler({
    delay: 10,
    refresh: async (sessionID) => {
      calls.push(sessionID)
      if (calls.length === 2) started.resolve()
      await response.promise
    },
    onError: started.reject,
  })
  try {
    scheduler.schedule("first")
    scheduler.schedule("second")
    await started.promise
    expect(calls).toEqual(["first", "second"])
  } finally {
    scheduler.dispose()
    response.resolve()
  }
})

test("a failed refresh is reported and subsequent events can refresh again", async () => {
  const failure = new Error("Unavailable")
  const failed = Promise.withResolvers<void>()
  const recovered = Promise.withResolvers<void>()
  const errors: unknown[] = []
  let calls = 0
  const scheduler = createSessionRefreshScheduler({
    delay: 10,
    refresh: async () => {
      calls++
      if (calls === 1) throw failure
      recovered.resolve()
    },
    onError: (error) => {
      errors.push(error)
      failed.resolve()
    },
  })
  try {
    scheduler.schedule("session")
    await failed.promise
    scheduler.schedule("session")
    await recovered.promise
    expect(errors).toEqual([failure])
    expect(calls).toBe(2)
  } finally {
    scheduler.dispose()
  }
})

test("disposing cancels timers and prevents follow-up fetches", async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<void>()
  let calls = 0
  const scheduler = createSessionRefreshScheduler({
    delay: 10,
    refresh: async () => {
      calls++
      started.resolve()
      await response.promise
    },
    onError: started.reject,
  })
  scheduler.schedule("running")
  await started.promise
  scheduler.schedule("running")
  scheduler.schedule("pending")
  scheduler.dispose()
  scheduler.schedule("disposed")
  response.resolve()
  await Bun.sleep(40)
  expect(calls).toBe(1)
})
