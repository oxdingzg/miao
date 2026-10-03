import { expect, test } from "@playwright/test"
import {
  assistant,
  assistantID,
  ended,
  event,
  partID,
  sessionID,
  setup,
  status,
  text,
  tool,
  user,
} from "../utils/session-v2"

test("groups singleton and separated context operations at correct boundaries", async ({ page }) => {
  await setup(page, {
    messages: [
      user(),
      assistant([
        tool("call_read", "read", "completed", { filePath: "src/a.ts" }),
        text("Boundary text"),
        tool("call_glob", "glob", "completed", { path: ".", pattern: "**/*.ts" }),
        tool("call_grep", "grep", "completed", { path: ".", pattern: "stable" }),
        tool("call_shell", "bash", "completed", { command: "echo done" }, "done"),
        tool("call_list", "list", "completed", { path: "src" }),
      ]),
    ],
  })
  await expect(page.locator('[data-timeline-part-ids="call_read"]')).toBeVisible()
  await expect(page.locator('[data-timeline-part-ids="call_glob,call_grep"]')).toBeVisible()
  await expect(page.locator('[data-timeline-part-ids="call_list"]')).toBeVisible()
  await expect(page.locator('[data-timeline-row="AssistantPart"]')).toHaveCount(5)
})

test("converges when idle arrives before final text and step settlement", async ({ page }) => {
  const message = assistant([text("Partial")], { completed: false })
  const timeline = await setup(page, { messages: [user(), message] })
  await timeline.send(status("busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await timeline.send(status("idle"))
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
  await timeline.send(
    event("session.next.text.ended", {
      sessionID,
      timestamp: 1700000002000,
      assistantMessageID: assistantID,
      textID: "text_0",
      text: "Final after early idle",
    }),
  )
  await expect(page.locator(`[data-timeline-part-id="${partID("text")}"]`)).toContainText("Final after early idle")
  await timeline.send(ended(message))
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${partID("text")}"]`)).toContainText("Final after early idle")
})
