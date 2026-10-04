import { expect, test } from "@playwright/test"
import {
  assistant,
  directory,
  event,
  partID,
  sessionID,
  setup,
  text,
  tool,
  user,
  type Message,
} from "../utils/session-v2"
import { expectAppVisible } from "../utils/waits"
import {
  analyzeVisualObservations,
  defineVisualRegions,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../utils/visual-stability"
import type { Page } from "@playwright/test"

const contextIDs = ["prt_0100_read", "prt_0101_glob", "prt_0102_grep", "prt_0103_list"]
const followingTextID = partID("text", 0, "msg_assistant_0010")
const inputs = [
  { filePath: "src/recent-a.ts", offset: 0, limit: 120 },
  { path: directory, pattern: "**/*.ts" },
  { path: directory, pattern: "Explored", include: "*.ts" },
  { path: "src" },
]
const names = ["read", "glob", "grep", "list"]
const settings = { editToolPartsExpanded: true, shellToolPartsExpanded: true, showReasoningSummaries: true }

test.describe("regression: session timeline context group resize", () => {
  test("remeasures a recent explored context group before the next paint", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await setup(page, {
      messages: [...Array.from({ length: 8 }, (_, index) => turn(index, false)).flat(), ...turn(10, true)],
      settings,
    })
    await expectAppVisible(page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"]`))
    await expectAppVisible(page.locator(`[data-timeline-part-id="${followingTextID}"]`))
    await expect(
      page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"] [data-slot="collapsible-trigger"]`),
    ).toHaveAttribute("aria-expanded", "false")

    const samples = await sampleExpansion(page)
    const visibleOverlap = samples.filter((sample) => sample.frame >= 1 && sample.overlap > 0.5)

    expect(samples[0]?.overlap).toBe(0)
    expect(visibleOverlap).toEqual([])
    expect(samples.at(-1)?.expanded).toBe("true")
  })

  test("paints a stable exploring to explored transition", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    const timeline = await setup(page, {
      messages: [...Array.from({ length: 8 }, (_, index) => turn(index, false)).flat(), ...turn(10, true, "running")],
      settings,
    })
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    const context = page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"]`)
    await expectAppVisible(context)
    await expect(context.locator('[data-component="tool-status-title"]')).toHaveAttribute("aria-label", "Exploring")

    const contextSelector = `[data-timeline-part-ids="${contextIDs.join(",")}"]`
    const regions = defineVisualRegions({
      status: {
        selector: `${contextSelector} [data-component="tool-status-title"]`,
        opacitySelectors: ['[data-slot="tool-status-active"]', '[data-slot="tool-status-done"]'],
      },
      context: { selector: contextSelector, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingTextID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await startVisualProbe(page, regions)
    for (const index of contextIDs.keys()) {
      await timeline.send(
        event("session.next.tool.success", {
          sessionID,
          assistantMessageID: "msg_assistant_0010",
          callID: contextIDs[index]!,
          timestamp: 1700000102000 + index,
          structured: {},
          content: [{ type: "text", text: `Completed ${names[index]}.\n${"detail line\n".repeat(8)}` }],
          provider: { executed: false },
        }),
      )
    }

    await expect(context.locator('[data-component="tool-status-title"]')).toHaveAttribute("aria-label", "Explored")
    await expect(context.locator('[data-slot="tool-status-done"]')).toHaveCSS("opacity", "1")
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & { __visualStabilityProbe?: { samples: { regions: { status?: { label?: string } } }[] } }
          ).__visualStabilityProbe?.samples.some((sample) => sample.regions.status?.label === "Explored"),
        ),
      )
      .toBe(true)
    const trace = await stopVisualProbe<keyof typeof regions>(page)
    const labels = trace.samples
      .map((sample) => sample.regions.status?.label)
      .filter((value): value is string => !!value)
      .filter((value, index, all) => value !== all[index - 1])
    const issues = analyzeVisualObservations(
      trace.samples,
      visualPlan(regions, [
        { type: "required", regions: ["context", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all" },
        { type: "label-stability", regions: "all" },
        { type: "flow", regions: ["context", "following"] },
      ]),
    )

    expect(labels).toEqual(["Exploring", "Explored"])
    expect(issues, JSON.stringify(trace.samples, null, 2)).toEqual([])
  })
})

async function sampleExpansion(page: Page) {
  return page.evaluate(
    ({ contextIDs, followingTextID }) =>
      new Promise<
        {
          frame: number
          label: string
          scrollTop: number
          scrollHeight: number
          contextBottom: number
          textTop: number
          overlap: number
          gap: number
          expanded: string | null
        }[]
      >((resolve) => {
        const context = document.querySelector<HTMLElement>(`[data-timeline-part-ids="${contextIDs.join(",")}"]`)
        const text = document.querySelector<HTMLElement>(`[data-timeline-part-id="${followingTextID}"]`)
        const scroller = context?.closest<HTMLElement>(".scroll-view__viewport")
        const trigger = context?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
        const contextRow = context?.closest<HTMLElement>('[data-timeline-row="AssistantPart"]')
        const textRow = text?.closest<HTMLElement>('[data-timeline-row="AssistantPart"]')
        if (!context || !text || !scroller || !trigger || !contextRow || !textRow)
          throw new Error("missing regression nodes")

        scroller.scrollTop = scroller.scrollHeight
        const samples: {
          frame: number
          label: string
          scrollTop: number
          scrollHeight: number
          contextBottom: number
          textTop: number
          overlap: number
          gap: number
          expanded: string | null
        }[] = []
        const capture = (frame: number, label: string) => {
          const contextRect = contextRow.getBoundingClientRect()
          const textRect = textRow.getBoundingClientRect()
          samples.push({
            frame,
            label,
            scrollTop: Math.round(scroller.scrollTop * 10) / 10,
            scrollHeight: Math.round(scroller.scrollHeight * 10) / 10,
            contextBottom: Math.round(contextRect.bottom * 10) / 10,
            textTop: Math.round(textRect.top * 10) / 10,
            overlap: Math.max(0, Math.round((contextRect.bottom - textRect.top) * 10) / 10),
            gap: Math.max(0, Math.round((textRect.top - contextRect.bottom) * 10) / 10),
            expanded: trigger.getAttribute("aria-expanded"),
          })
        }

        capture(-1, "before")
        trigger.click()
        capture(0, "sync-after-click")

        let frame = 1
        const tick = () => {
          setTimeout(() => {
            capture(frame, "painted")
            frame += 1
            if (frame > 8) {
              resolve(samples)
              return
            }
            requestAnimationFrame(tick)
          }, 0)
        }
        requestAnimationFrame(tick)
      }),
    { contextIDs, followingTextID },
  )
}

function turn(index: number, target: boolean, status: "running" | "completed" = "completed"): Message[] {
  return [
    user(`User message ${index}`, {
      id: `msg_user_${String(index).padStart(4, "0")}`,
      created: 1700000000000 + index * 10000,
    }),
    assistant(
      target
        ? [
            ...contextIDs.map((id, ordinal) =>
              tool(
                id,
                names[ordinal]!,
                status,
                inputs[ordinal]!,
                `Completed ${names[ordinal]}.\n${"detail line\n".repeat(8)}`,
              ),
            ),
            text("This assistant text is immediately after the explored context group."),
          ]
        : [text(`Assistant filler ${index}. ${"filler ".repeat(60)}`)],
      {
        id: `msg_assistant_${String(index).padStart(4, "0")}`,
        created: 1700000001000 + index * 10000,
        completed: status === "completed",
      },
    ),
  ]
}
