import { expect, test } from "@playwright/test"
import { assistant, assistantID, event, partID, sessionID, setup, text, user } from "../utils/session-v2"

const textEnded = (value: string, id: string) =>
  event("session.next.text.ended", {
    sessionID,
    timestamp: 1700000002000,
    assistantMessageID: assistantID,
    textID: id,
    text: value,
  })
const textStarted = (id: string) =>
  event("session.next.text.started", {
    sessionID,
    timestamp: 1700000002000,
    assistantMessageID: assistantID,
    textID: id,
  })

test("keeps one connection open while delivering multiple events", async ({ page }) => {
  const timeline = await setup(page)

  await timeline.transport.send(textStarted("prt_transport_first"))
  await timeline.transport.send(textStarted("prt_transport_second"))
  const first = await timeline.transport.send(textEnded("first event", "prt_transport_first"))
  const second = await timeline.transport.send(textEnded("second event", "prt_transport_second"))

  await timeline.waitForPart(partID("text", 0))
  await timeline.waitForPart(partID("text", 1))
  expect(first.connectionID).toBe(second.connectionID)
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
  expect(await timeline.transport.acknowledgements()).toHaveLength(4)
})

test("delivers a burst from one stream chunk", async ({ page }) => {
  const timeline = await setup(page)
  await timeline.transport.burst([textStarted("prt_transport_burst_a"), textStarted("prt_transport_burst_b")])
  const acknowledgements = await timeline.transport.burst([
    textEnded("burst a", "prt_transport_burst_a"),
    textEnded("burst b", "prt_transport_burst_b"),
  ])

  await timeline.waitForPart(partID("text", 0))
  await timeline.waitForPart(partID("text", 1))
  expect(acknowledgements.map((item) => item.chunkCount)).toEqual([1, 1])
  expect(new Set(acknowledgements.map((item) => item.deliveryID)).size).toBe(2)
})

test("parses split JSON and a split multibyte code point", async ({ page }) => {
  const timeline = await setup(page)
  await timeline.transport.send(textStarted("prt_transport_split"))
  const payload = textEnded("split snowman \u2603\u2603\u2603", "prt_transport_split")
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
  const snowman = new TextEncoder().encode("\u2603")[0]!
  const multibyte = encoded.indexOf(snowman)

  const acknowledgement = await timeline.transport.split(payload, [9, multibyte + 1, multibyte + 2])

  await timeline.waitForPart(partID("text", 0))
  await expect(page.locator(`[data-timeline-part-id="${partID("text")}"]`)).toContainText(
    "split snowman \u2603\u2603\u2603",
  )
  expect(acknowledgement.chunkCount).toBe(4)
})

test("delivers server heartbeat without mutating the timeline", async ({ page }) => {
  const sentinelID = partID("text", 1)
  const timeline = await setup(page, {
    messages: [user(), assistant([text("steady")])],
  })
  await timeline.waitForPart(partID("text", 0))
  const steady = page.locator(`[data-timeline-part-id="${partID("text", 0)}"] [data-component="markdown"]`)
  await expect(steady).toHaveText("steady")

  await timeline.transport.writeRaw(": heartbeat\n\n")
  await timeline.transport.send(textStarted("text_1"))
  await timeline.transport.send(textEnded("heartbeat processed", "text_1"))
  await timeline.waitForPart(sentinelID)

  await expect(steady).toHaveText("steady")
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
})

test("reconnects after a clean close", async ({ page }) => {
  const timeline = await setup(page)
  const first = await timeline.transport.waitForConnection()

  await timeline.transport.close()
  const second = await timeline.transport.waitForConnection({ after: first.id })
  await timeline.transport.send(textStarted("prt_transport_close"))
  await timeline.transport.send(textEnded("after close", "prt_transport_close"))

  await timeline.waitForPart(partID("text", 0))
  expect(second.id).toBeGreaterThan(first.id)
  expect((await timeline.transport.connections())[0]?.endedBy).toBe("close")
})

test("reconnects after a stream error", async ({ page }) => {
  const timeline = await setup(page)
  const first = await timeline.transport.waitForConnection()

  await timeline.transport.error("contract failure")
  const second = await timeline.transport.waitForConnection({ after: first.id })
  await timeline.transport.send(textStarted("prt_transport_error"))
  await timeline.transport.send(textEnded("after error", "prt_transport_error"))

  await timeline.waitForPart(partID("text", 0))
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(2)
  expect(second.id).toBeGreaterThan(first.id)
  expect((await timeline.transport.connections())[0]?.endedBy).toBe("error")
})

test("does not request replay when reconnecting the volatile V2 event stream", async ({ page }) => {
  const timeline = await setup(page, {})
  await timeline.transport.send(textStarted("prt_transport_id"))
  const first = await timeline.transport.send(textEnded("event with id", "prt_transport_id"), {
    id: "timeline-event-7",
  })
  await timeline.waitForPart(partID("text", 0))

  await timeline.transport.error("retry with event id")
  const connection = await timeline.transport.waitForConnection({ after: first.connectionID })

  expect(first.eventID).toBe("timeline-event-7")
  expect(connection.headers["last-event-id"]).toBeUndefined()
})

test("passes through non-event fetches", async ({ page }) => {
  const timeline = await setup(page)

  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health")
    return response.json()
  })

  expect(health).toMatchObject({ healthy: true, pid: 1 })
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
})
