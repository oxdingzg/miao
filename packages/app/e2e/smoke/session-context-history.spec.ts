import { expect, test } from "@playwright/test"
import { assistant, assistantID, model, setup, text, user } from "../utils/session-v2"

const step = (id: string, time: number) => ({
  id,
  time,
  messageID: assistantID,
  model,
  cost: 0.01,
  finish: "stop",
  ttftMs: 250,
  tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 200, write: 50 } },
})

test("context history pages durable usage and remains usable after a fetch failure", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await setup(page, { messages: [user(), assistant([text("Completed provider step")])] })
  let failed = true
  const cursors: (string | null)[] = []
  await page.route("**/api/session/*/usage-history*", async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before")
    cursors.push(before)
    if (failed) {
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "unavailable" }),
      })
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: before
          ? { items: [step("evt_old", 1700000000000)] }
          : { items: [step("evt_new", 1700000002000)], next: "evt_new" },
      }),
    })
  })
  await page.getByRole("button", { name: "View context usage" }).click()
  const chart = page.locator('[data-component="context-timeline"]')
  await expect(chart.getByRole("button", { name: "Retry usage history" })).toBeVisible()
  failed = false
  await chart.getByRole("button", { name: "Retry usage history" }).click()
  await expect(chart.getByRole("button", { name: /350 prompt tokens/ })).toHaveCount(1)
  await chart.getByRole("button", { name: "Load more" }).click()
  await expect(chart.getByRole("button", { name: /350 prompt tokens/ })).toHaveCount(2)
  expect(cursors).toContain("evt_new")
  await expect(chart.getByRole("button", { name: "Load more" })).toHaveCount(0)
  await chart
    .getByRole("button", { name: /350 prompt tokens/ })
    .first()
    .focus()
  await expect(chart.getByRole("button", { name: /350 prompt tokens/ }).first()).toHaveAttribute("aria-pressed", "true")
  await expect(chart).toContainText("250 ms to first token")
  const composition = page.locator('[data-component="context-composition"]')
  await expect(composition).toContainText("not saved request snapshots")
  await composition
    .getByRole("button", { name: /reported prompt tokens/ })
    .first()
    .focus()
  await expect(composition.getByRole("button", { name: /reported prompt tokens/ }).first()).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await chart.screenshot({ path: testInfo.outputPath("context-history.png") })
  await composition.screenshot({ path: testInfo.outputPath("context-composition.png") })
  expect(errors).toEqual([])
})
