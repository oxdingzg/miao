import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createScrollAnchoring, createTranscriptWindow } from "../../src/util/transcript-window"

test("history is mounted in bounded pages without losing local messages or jump targets", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `message-${i}` }))
    const [messages, setMessages] = createSignal(all)
    const window = createTranscriptWindow(messages, { windowSize: 40 })
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(165)
    expect(messages()).toHaveLength(205)
    expect(window.reveal("message-125")).toBe(true)
    expect(window.start()).toBe(125)
    expect(window.messages()).toHaveLength(40)
    expect(window.messages()[0].id).toBe("message-125")
    expect(window.messages().at(-1)?.id).toBe("message-164")
    setMessages([...all, { id: "new" }])
    expect(window.start()).toBe(125)
    expect(window.messages().at(-1)?.id).toBe("message-164")
    expect(window.reveal("message-3")).toBe(true)
    expect(window.start()).toBe(3)
    expect(window.reveal("message-3")).toBe(false)
    window.reset()
    expect(window.messages()).toHaveLength(40)
    expect(window.start()).toBe(166)
    expect(window.reveal("missing")).toBe(false)
    dispose()
  })
})

test("spacers account for every message outside the window", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], { windowSize: 40, estimate: 3 })
    expect(window.top()).toBe(window.start() * 3)
    expect(window.bottom()).toBe((205 - window.end()) * 3)
    expect(window.top() + window.messages().length * 3 + window.bottom()).toBe(205 * 3)
    dispose()
  })
})

test("follow reveals local history above and hides it again below", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 300 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], {
      windowSize: 40,
      step: 20,
      estimate: 3,
      margin: 2,
    })
    const mounted = 40 * 3
    // Sitting at the bottom pins the newest window.
    window.follow({ scrollTop: 300 * 3 - 20, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(260)
    expect(window.bottom()).toBe(0)
    // Scrolling into the leading spacer reveals an older page locally.
    window.follow({ scrollTop: window.top() - 1, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(240)
    // Scrolling further up eventually reaches the oldest loaded message.
    for (let i = 0; i < 20; i++)
      window.follow({ scrollTop: window.top() - 1, viewportHeight: 20, mountedHeight: mounted })
    expect(window.start()).toBe(0)
    expect(window.top()).toBe(0)
    // Scrolling down into the trailing spacer brings back the newer messages.
    window.follow({ scrollTop: 0, viewportHeight: 20, mountedHeight: mounted })
    const before = window.start()
    window.follow({
      scrollTop: window.top() + mounted - 1,
      viewportHeight: 20,
      mountedHeight: mounted,
    })
    expect(window.start()).toBeGreaterThan(before)
    expect(window.bottom()).toBeGreaterThan(0)
    dispose()
  })
})

test("estimate recalibrates while following the tail and holds once anchored", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 300 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], { windowSize: 40, estimate: 8, margin: 2 })
    // Following the tail (no anchor): a viewport in the middle of the mounted
    // window still lets the measured rows replace the stale spacer estimate.
    window.follow({ scrollTop: window.top() + 80, viewportHeight: 20, mountedHeight: 40 * 5 })
    expect(window.start()).toBe(260)
    expect(window.top()).toBe(window.start() * 5)
    // Anchored in history: a very different mounted average must not reshape
    // the spacers under the reader, or the block walks off the viewport.
    window.follow({ scrollTop: 1000, viewportHeight: 20, mountedHeight: 40 * 1 })
    expect(window.top()).toBe(window.start() * 5)
    dispose()
  })
})

test("scrolling up holds the trailing rows until scrolling goes idle", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 300 }, (_, i) => ({ id: `${i}` }))
    const window = createTranscriptWindow(createSignal(all)[0], {
      windowSize: 40,
      step: 20,
      estimate: 3,
      margin: 2,
      maxWindowSize: 60,
    })
    const metrics = (scrollTop: number) => ({
      scrollTop,
      viewportHeight: 20,
      mountedHeight: window.messages().length * 3,
    })
    window.follow(metrics(300 * 3 - 20))
    expect(window.messages()).toHaveLength(40)
    // Moving up mounts above without dropping the trailing rows.
    window.follow(metrics(window.top() - 1))
    expect(window.start()).toBe(240)
    expect(window.messages()).toHaveLength(60)
    // Held rows stay bounded by maxWindowSize past the window start.
    window.follow(metrics(window.top() - 1))
    expect(window.start()).toBe(220)
    expect(window.messages()).toHaveLength(60)
    // Scrolling down through the held rows keeps them mounted.
    window.follow(metrics(window.top() + 80))
    expect(window.messages()).toHaveLength(60)
    // Going idle releases them again.
    const idle = metrics(window.top() + 80)
    for (let i = 0; i < 12; i++) window.follow(idle)
    expect(window.messages()).toHaveLength(40)
    dispose()
  })
})

test("scroll anchoring compensates once the measurement settles", () => {
  // Rows are mutated in place, the way a surviving renderable is re-measured
  // after a mutation.
  const rows = [
    { y: 10, height: 5 },
    { y: 15, height: 20 },
    { y: 35, height: 0 },
    { y: 35, height: 5 },
  ]
  const anchoring = createScrollAnchoring<{ y: number; height: number }>({ atBottom: () => false })
  const captured = anchoring.capture({ rows, from: 0, contentTop: 0, scrollHeight: 60 })
  // The anchor is the middle of the laid-out rows; rows without layout are
  // never chosen.
  expect(captured?.anchor.offset).toBe(15)
  // Rows before `from` are never chosen as anchors.
  expect(anchoring.capture({ rows, from: 3, contentTop: 0, scrollHeight: 60 })?.anchor.offset).toBe(35)
  expect(anchoring.capture({ rows: rows.slice(0, 2), from: 2, contentTop: 0, scrollHeight: 60 })).toBeUndefined()
  anchoring.arm(captured!)
  let scrolled: number | undefined
  const apply = (height: number) =>
    anchoring.apply({ rows, from: 0, contentTop: 0, scrollHeight: height }, (delta) => (scrolled = delta))
  // First pass only records the measurement.
  apply(60)
  expect(scrolled).toBeUndefined()
  // The mutation moved the anchored row 30 rows down, but a fresh measurement
  // is not trusted until it repeats on the next pass.
  rows[1].y = 45
  rows[3].y = 65
  apply(90)
  expect(scrolled).toBeUndefined()
  apply(90)
  expect(scrolled).toBe(30)
})

test("scroll anchoring keeps the first anchor across chained mutations", () => {
  const rows = [
    { y: 15, height: 20 },
    { y: 35, height: 5 },
    { y: 40, height: 5 },
  ]
  const anchoring = createScrollAnchoring<{ y: number; height: number }>({ atBottom: () => false })
  // The middle row of three is the anchor.
  const first = anchoring.capture({ rows, from: 0, contentTop: 0, scrollHeight: 60 })
  expect(first?.anchor.offset).toBe(35)
  anchoring.arm(first!)
  // A second mutation arms a fresh capture; the first anchor must survive so
  // the accumulated shift is compensated once.
  const second = anchoring.capture({ rows: rows.slice(2), from: 0, contentTop: 0, scrollHeight: 60 })
  anchoring.arm(second!)
  let scrolled: number | undefined
  const apply = () =>
    anchoring.apply({ rows, from: 0, contentTop: 0, scrollHeight: 90 }, (delta) => (scrolled = delta))
  rows[0].y = 55
  rows[1].y = 95
  rows[2].y = 80
  for (let i = 0; i < 3; i++) apply()
  // 95 - 35: the delta measured from the first anchor, not the second.
  expect(scrolled).toBe(60)
})

test("scroll anchoring skips compensation when the reader has reached the bottom", () => {
  const anchoring = createScrollAnchoring<{ y: number; height: number }>({ atBottom: () => true })
  const rows = [{ y: 5, height: 20 }]
  anchoring.arm(anchoring.capture({ rows, from: 0, contentTop: 0, scrollHeight: 100 })!)
  let scrolled: number | undefined
  for (let i = 0; i < 3; i++)
    anchoring.apply({ rows, from: 0, contentTop: 0, scrollHeight: 140 }, (delta) => (scrolled = delta))
  expect(scrolled).toBeUndefined()
})

test("scroll anchoring falls back to the height delta when the anchored row is gone", () => {
  const anchoring = createScrollAnchoring<{ y: number; height: number }>({ atBottom: () => false })
  const rows = [{ y: 5, height: 20 }]
  anchoring.arm(anchoring.capture({ rows, from: 0, contentTop: 0, scrollHeight: 100 })!)
  let scrolled: number | undefined
  const apply = () => anchoring.apply({ rows, from: 0, contentTop: 0, scrollHeight: 140 }, (delta) => (scrolled = delta))
  apply()
  expect(scrolled).toBeUndefined()
  rows.length = 0
  apply()
  apply()
  expect(scrolled).toBe(40)
})

test("server-prepended pages preserve the anchor until explicitly revealed", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 100 }, (_, i) => ({ id: `${i}` }))
    const [messages, setMessages] = createSignal(all)
    const window = createTranscriptWindow(messages, { windowSize: 40 })
    expect(window.start()).toBe(60)
    window.reveal("55")
    setMessages([{ id: "older-1" }, { id: "older-0" }, ...messages()])
    expect(window.start()).toBe(57)
    expect(window.messages()[0].id).toBe("55")
    window.reset()
    expect(window.start()).toBe(62)
    window.reveal("older-0")
    expect(window.start()).toBe(1)
    setMessages([{ id: "other-session" }])
    expect(window.messages().map((message) => message.id)).toEqual(["other-session"])
    dispose()
  })
})
