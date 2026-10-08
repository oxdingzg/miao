import { expect, test } from "@playwright/test"
import {
  defineVisualRegions,
  reportVisualStability,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../../utils/visual-stability"
import {
  assistantID,
  assistantMessage,
  event,
  partUpdated,
  sessionPartID,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
  waitForVisualSettle,
} from "./fixture"

const inputs = {
  read: { filePath: "src/a.ts", offset: 0, limit: 120 },
  glob: { path: ".", pattern: "**/*.ts" },
  grep: { path: ".", pattern: "stable", include: "*.ts" },
  list: { path: "src" },
}

test("appends context operations while the group is expanded", async ({ page }, testInfo) => {
  const firstID = "prt_append_01_read"
  const followingSeedID = "prt_append_99_following"
  const followingID = sessionPartID(assistantID, "text", 0)
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([toolPart(firstID, "read", "running", inputs.read), textPart(followingSeedID, "Following append")], {
        completed: false,
      }),
    ],
    cpuRate: 4,
  })
  const initialGroup = `[data-timeline-part-ids="${firstID}"]`
  await page.locator(`${initialGroup} [data-slot="collapsible-trigger"]`).click()
  await waitForVisualSettle(page, [initialGroup, `[data-timeline-part-id="${followingID}"]`])
  const regions = defineVisualRegions({
    context: {
      selector: '[data-timeline-part-ids^="prt_append_01_read"]',
      closest: '[data-timeline-row="AssistantPart"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(toolPart("prt_append_02_glob", "glob", "running", inputs.glob)), 180)
  await timeline.send(partUpdated(toolPart("prt_append_03_grep", "grep", "completed", inputs.grep)), 240)
  await timeline.send(partUpdated(toolPart("prt_append_04_list", "list", "completed", inputs.list)), 500)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-append",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["context", "following"] },
        { type: "unique", regions: ["context", "following"] },
        { type: "stable", regions: ["context", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: ["following"], maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
        { type: "preserve-bottom-anchor" },
        { type: "flow", regions: ["context", "following"] },
      ],
      { perMarker: true },
    ),
  )
  // V2 appends tools after the trailing text, so the new operations form a
  // second group instead of joining the seeded one.
  await expect(page.locator('[data-timeline-part-ids="prt_append_01_read"]')).toBeVisible()
  await expect(
    page.locator('[data-timeline-part-ids="prt_append_02_glob,prt_append_03_grep,prt_append_04_list"]'),
  ).toBeVisible()
  await expect(
    page.locator('[data-timeline-part-ids^="prt_append_01_read"] [data-slot="collapsible-trigger"]'),
  ).toHaveAttribute("aria-expanded", "true")
})

test("splits and merges context groups when a middle text part changes", async ({ page }, testInfo) => {
  const textID = "prt_split_02_text"
  // V2 has no part removal: the boundary text seeds empty (so the groups start
  // merged), streaming text into it splits them, and clearing it merges again.
  const followingID = sessionPartID(assistantID, "text", 1)
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart("prt_split_01_read", "read", "completed", inputs.read),
          textPart(textID, ""),
          toolPart("prt_split_03_glob", "glob", "completed", inputs.glob),
          textPart("prt_split_99_following", "Following split groups"),
        ],
        { completed: false },
      ),
    ],
    cpuRate: 4,
  })
  await expect(page.locator('[data-timeline-part-ids="prt_split_01_read,prt_split_03_glob"]')).toBeVisible()
  const regions = defineVisualRegions({
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(textPart(textID, "Boundary restored. ".repeat(6))), 500)
  await expect(page.locator('[data-timeline-part-ids="prt_split_01_read"]')).toBeVisible()
  await expect(page.locator('[data-timeline-part-ids="prt_split_03_glob"]')).toBeVisible()
  await timeline.send(partUpdated(textPart(textID, "")), 500)
  await expect(page.locator('[data-timeline-part-ids="prt_split_01_read,prt_split_03_glob"]')).toBeVisible()
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-split-merge",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["following"] },
        { type: "unique", regions: ["following"] },
        { type: "stable", regions: ["following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 1 },
        { type: "label-stability", regions: "all" },
      ],
      { perMarker: true },
    ),
  )
})

test("removing the first context member replaces the group once without overlapping following content", async ({
  page,
}, testInfo) => {
  const ids = ["prt_key_01_read", "prt_key_02_glob", "prt_key_03_grep"]
  // Legacy-bridge coverage: the V2 producer never removes parts, but the app
  // keeps honoring removal events from pre-V2 servers.
  const followingSeedID = "prt_key_99_following"
  const followingID = sessionPartID(assistantID, "text", 0)
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(ids[0]!, "read", "completed", inputs.read),
        toolPart(ids[1]!, "glob", "completed", inputs.glob),
        toolPart(ids[2]!, "grep", "completed", inputs.grep),
        textPart(followingSeedID, "Following replaced group"),
      ]),
    ],
    cpuRate: 4,
  })
  const original = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
  const originalRowKey = await original.evaluate((element) =>
    element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key"),
  )
  await original.locator('[data-slot="collapsible-trigger"]').click()
  await expect(original.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
  const regions = defineVisualRegions({
    context: {
      selector: '[data-timeline-part-ids*="prt_key_02_glob"]',
      closest: '[data-timeline-row="AssistantPart"]',
    },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: ids[0] }),
    500,
  )
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "context-first-remove",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["context", "following"] },
      { type: "unique", regions: ["context", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 0 },
      { type: "label-stability", regions: "all" },
      { type: "flow", regions: ["context", "following"] },
    ]),
  )
  await expect(page.locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"]`)).toBeVisible()
  expect(
    await page
      .locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"]`)
      .evaluate((element) => element.closest("[data-timeline-key]")?.getAttribute("data-timeline-key")),
  ).toBe(originalRowKey)
  await expect(
    page.locator(`[data-timeline-part-ids="${ids.slice(1).join(",")}"] [data-slot="collapsible-trigger"]`),
  ).toHaveAttribute("aria-expanded", "true")
})
