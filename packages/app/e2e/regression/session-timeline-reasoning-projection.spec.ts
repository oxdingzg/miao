import { expect, test } from "@playwright/test"
import { assistant, reasoning, setup, status, text, tool, user, partID } from "../utils/session-v2"

const profiles = [
  { name: "summaries off no reasoning", summaries: false, reasoning: "", other: false, thinking: true, body: false },
  {
    name: "summaries off reasoning heading",
    summaries: false,
    reasoning: "## Inspecting stability",
    other: false,
    thinking: true,
    body: false,
  },
  {
    name: "summaries off with visible tool",
    summaries: false,
    reasoning: "## Inspecting stability",
    other: true,
    thinking: true,
    body: false,
  },
  { name: "summaries on no content", summaries: true, reasoning: "", other: false, thinking: true, body: false },
  {
    name: "summaries on blank reasoning",
    summaries: true,
    reasoning: "   ",
    other: false,
    thinking: true,
    body: false,
  },
  {
    name: "summaries on visible reasoning",
    summaries: true,
    reasoning: "## Inspecting stability",
    other: false,
    thinking: false,
    body: true,
  },
  {
    name: "summaries on visible tool no reasoning",
    summaries: true,
    reasoning: "",
    other: true,
    thinking: false,
    body: false,
  },
] as const

for (const profile of profiles) {
  test(`projects busy reasoning profile ${profile.name}`, async ({ page }) => {
    const reasoningID = partID("reasoning")
    const parts = [
      ...(profile.reasoning ? [reasoning(profile.reasoning)] : []),
      ...(profile.other
        ? [tool(`call_reasoning_${profiles.indexOf(profile)}`, "skill", "running", { name: "inspect" })]
        : []),
    ]
    const timeline = await setup(page, {
      messages: [user(), assistant(parts, { completed: false })],
      settings: { showReasoningSummaries: profile.summaries },
    })
    await timeline.send(status("busy"))

    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(profile.thinking ? 1 : 0)
    await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(profile.body ? 1 : 0)
    if (!profile.summaries && profile.reasoning.trim()) {
      await expect(page.getByText("Inspecting stability", { exact: true })).toBeVisible()
    }
  })
}

test("does not infer reasoning visibility from provider identity", async ({ page }) => {
  const timeline = await setup(page, {
    messages: [user(), assistant([text("No reasoning payload")], { completed: false })],
    settings: { showReasoningSummaries: true },
  })
  await timeline.send(status("busy"))

  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-part-id*="reasoning"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${partID("text")}"]`)).toBeVisible()
})
