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
  completedAssistantInfo,
  event,
  messageUpdated,
  partDelta,
  partUpdated,
  sessionPartID,
  setupTimeline,
  shell,
  status,
  textPart,
  toolPart,
  userMessage,
} from "./fixture"

test("keeps unchanged siblings stable while a middle part is inserted and removed", async ({ page }, testInfo) => {
  const firstID = "prt_mutation_01_first"
  const middleID = "prt_mutation_02_middle"
  const lastID = "prt_mutation_03_last"
  // DOM ids: the seeded texts take ordinals 0 and 1; the live-inserted middle
  // text appends at ordinal 2. Removal goes through the legacy bridge event —
  // the V2 producer has no removal, so this is reducer-hardening coverage.
  const firstDomID = sessionPartID(assistantID, "text", 0)
  const lastDomID = sessionPartID(assistantID, "text", 1)
  const middleDomID = sessionPartID(assistantID, "text", 2)
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([textPart(firstID, "First stable row"), textPart(lastID, "Last stable row")], {
        completed: false,
      }),
    ],
    cpuRate: 4,
  })
  const regions = defineVisualRegions({
    first: { selector: `[data-timeline-part-id="${firstDomID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    last: { selector: `[data-timeline-part-id="${lastDomID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(textPart(middleID, "Inserted middle row. ".repeat(12))), 350)
  await expect(page.locator(`[data-timeline-part-id="${middleDomID}"]`)).toBeVisible()
  await timeline.send(
    event("message.part.removed", { sessionID: "ses_timeline_stability", messageID: assistantID, partID: middleID }),
    500,
  )
  await expect(page.locator(`[data-timeline-part-id="${middleDomID}"]`)).toHaveCount(0)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "middle-insert-remove", trace, stablePairPlan(regions, 1))
})

test("streams text through growth, canonical replacement, and completion", async ({ page }, testInfo) => {
  const seedTextID = "prt_text_reconcile"
  const seedFollowingID = "prt_text_reconcile_following"
  // Seeded text DOM ids follow the content ordinal, not the event id.
  const textID = sessionPartID(assistantID, "text", 0)
  const followingID = sessionPartID(assistantID, "text", 1)
  const assistant = assistantMessage([textPart(seedTextID, "Starting"), textPart(seedFollowingID, "Following text row")], {
    completed: false,
  })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant], cpuRate: 4 })
  const regions = defineVisualRegions({
    text: { selector: `[data-timeline-part-id="${textID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: { selector: `[data-timeline-part-id="${followingID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partDelta(seedTextID, " streamed content"), 100)
  await timeline.send(partDelta(seedTextID, "\n\n- item one\n- item two\n- item three"), 180)
  await timeline.send(partUpdated(textPart(seedTextID, "Canonical replacement with a shorter final paragraph.")), 200)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 500)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "text-reconcile",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["text", "following"] },
      { type: "unique", regions: ["text", "following"] },
      { type: "stable", regions: ["text", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      // V2 separates completion into its own step.ended pass, so the assistant
      // meta row lands as a third movement after the deltas and the canonical
      // replacement.
      { type: "motion", regions: "all", maxPositionReversals: 2, maxReversals: 2 },
      { type: "label-stability", regions: "all" },
      { type: "preserve-bottom-anchor" },
      { type: "flow", regions: ["text", "following"] },
    ]),
  )
})

test("inserts a completed question between stable rows", async ({ page }, testInfo) => {
  const firstID = "prt_question_01_first"
  const questionID = "prt_question_02_hidden"
  const lastID = "prt_question_03_last"
  const input = { questions: [{ header: "Choice", question: "Keep stable?", options: [] }] }
  // Seeded text DOM ids follow the content ordinal, not the event id.
  const firstDomID = sessionPartID(assistantID, "text", 0)
  const lastDomID = sessionPartID(assistantID, "text", 1)
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          textPart(firstID, "Before question"),
          toolPart(questionID, "question", "running", input),
          textPart(lastID, "After question"),
        ],
        { completed: false },
      ),
    ],
    cpuRate: 4,
  })
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  const regions = defineVisualRegions({
    first: { selector: `[data-timeline-part-id="${firstDomID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    last: { selector: `[data-timeline-part-id="${lastDomID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    partUpdated(toolPart(questionID, "question", "completed", input, { metadata: { answers: [["Yes"]] } })),
    600,
  )
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toBeVisible()
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "question-insert", trace, stablePairPlan(regions, 0))
})

test("replaces thinking with an assistant error without a blank turn", async ({ page }, testInfo) => {
  const assistant = assistantMessage([], { completed: false })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant], cpuRate: 4 })
  await timeline.send(status("busy"), 150)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  const regions = defineVisualRegions({
    thinking: { selector: '[data-timeline-row="Thinking"]' },
    error: { selector: '[data-timeline-row="Error"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    messageUpdated({
      ...assistant.info,
      error: { name: "APIError", data: { message: "Provider failed visibly", isRetryable: false } },
    }),
    500,
  )
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="Error"]')).toContainText("Provider failed visibly")
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "thinking-error",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["thinking", "error"] },
      { type: "continuous-any", regions: ["thinking", "error"] },
      { type: "unique", regions: ["thinking", "error"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all" },
      { type: "label-stability", regions: "all" },
    ]),
  )
})

test("updates retry attempts and long provider messages without remounting the retry row", async ({
  page,
}, testInfo) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    cpuRate: 4,
  })
  await timeline.send(status("retry", 1), 120)
  await expect(page.locator('[data-timeline-row="Retry"]')).toBeVisible()
  const regions = defineVisualRegions({
    retry: { selector: '[data-timeline-row="Retry"]' },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    status("retry", 2, "A very long provider retry message ".repeat(8)),
    300,
  )
  await timeline.send(status("retry", 3), 300)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "retry-evolution",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["retry"] },
        { type: "unique", regions: ["retry"] },
        { type: "stable", regions: ["retry"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
      ],
      { perMarker: true },
    ),
  )
})

test("reducer-hardening: removes a historical turn one message at a time without moving a visible lower anchor twice", async ({
  page,
}, testInfo) => {
  const removeUserID = "msg_0500_remove_user"
  const removeAssistantID = "msg_0501_remove_assistant"
  const anchorUserID = "msg_2000_anchor_user"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(undefined, { id: removeUserID, created: 1690000000000 }),
      assistantMessage([textPart("prt_remove_text", "Removed historical content. ".repeat(15))], {
        id: removeAssistantID,
        parentID: removeUserID,
        created: 1690000001000,
      }),
      userMessage(undefined, { id: anchorUserID, created: 1700000000000 }),
      assistantMessage([textPart("prt_anchor_text", "Visible anchor response")], {
        id: "msg_2001_anchor_assistant",
        parentID: anchorUserID,
        created: 1700000001000,
      }),
    ],
    cpuRate: 4,
  })
  const regions = defineVisualRegions({
    anchor: { selector: `[data-timeline-row="UserMessage"][data-message-id="${anchorUserID}"]` },
  })
  await startVisualProbe(page, regions)
  await timeline.send(
    event("message.removed", { sessionID: "ses_timeline_stability", messageID: removeAssistantID }),
    200,
  )
  await timeline.send(event("message.removed", { sessionID: "ses_timeline_stability", messageID: removeUserID }), 500)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "historical-turn-remove",
    trace,
    visualPlan(
      regions,
      [
        { type: "required", regions: ["anchor"] },
        { type: "unique", regions: ["anchor"] },
        { type: "stable", regions: ["anchor"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all", maxPositionReversals: 0 },
        { type: "label-stability", regions: "all" },
      ],
      { perMarker: true },
    ),
  )
})

function stablePairPlan(
  regions: Record<"first" | "last", { selector: string; closest?: string }>,
  maxPositionReversals: number,
) {
  return visualPlan(regions, [
    { type: "required", regions: ["first", "last"] },
    { type: "unique", regions: ["first", "last"] },
    { type: "stable", regions: ["first", "last"] },
    { type: "opacity", regions: "all" },
    { type: "continuity", regions: "all" },
    { type: "motion", regions: "all", maxPositionReversals },
    { type: "label-stability", regions: "all" },
  ])
}
