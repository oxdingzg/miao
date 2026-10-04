import { base64Encode } from "@miao/core/util/encode"
import { expect, test } from "@playwright/test"
import type { OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import {
  assistant,
  directory,
  ended,
  event,
  model,
  partID,
  sessionID,
  status,
  text,
  title,
  user,
  userID,
} from "../utils/session-v2"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const initialPageSize = 20
const turnRootPageSize = 20
const assistants = Array.from({ length: initialPageSize + 1 }, (_, index) =>
  assistant([text(`Assistant response ${index}`)], {
    id: `msg_history_root_assistant_${String(index).padStart(4, "0")}`,
    created: 1700000001000 + index * 1000,
    completed: index < initialPageSize,
  }),
)
const messages = [user(), ...assistants]
const lastAssistant = assistants.at(-1)!
const lastPartID = partID("text", 0, lastAssistant.id)
const userPartID = `${userID}:text:0`

test.use({ viewport: { width: 646, height: 1385 } })
for (const scenario of ["completion", "interruption"] as const) {
  test(`keeps visible timeline content visible through ${scenario}`, async ({ page }) => {
    const requests: { before?: string; phase: "start" | "end" }[] = []
    const pages: { before?: string; limit: number }[] = []
    const history = Promise.withResolvers<void>()
    const transport = await installSseTransport<OpenCodeEventEncoded>(page, {
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
      retry: 20,
    })
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_history_root",
        worktree: directory,
        name: "History root",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: model.providerID,
            name: "OpenCode",
            models: { [model.id]: { id: model.id, name: "Claude Opus 4.6", limit: { context: 200000 } } },
          },
        ],
        connected: [model.providerID],
        default: { [model.providerID]: model.id },
      },
      sessions: [{ id: sessionID, projectID: "proj_history_root", directory, title, time: { created: 1, updated: 1 } }],
      sessionStatus: { [sessionID]: { type: "busy" } },
      beforeMessagesResponse: (request) => (request.before ? history.promise : Promise.resolve()),
      onMessages: (request) => {
        requests.push(request)
      },
      pageMessages: (_, limit, before) => {
        pages.push({ before, limit })
        const end = before ? messages.findIndex((message) => message.id === before) : messages.length
        const start = Math.max(0, end - limit)
        return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
      },
    })
    await page.addInitScript(() => {
      const visibleParts = () => {
        const virtual = document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
        const viewport = virtual?.closest<HTMLElement>(".scroll-view__viewport")
        const view = viewport?.getBoundingClientRect()
        if (!viewport || !view) return []
        return [...viewport.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
          .filter((part) => {
            const rect = part.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
          })
          .flatMap((part) => (part.dataset.timelinePartId ? [part.dataset.timelinePartId] : []))
      }
      const state = {
        armed: false,
        hidden: false,
        visibleParts: [] as string[],
        samples: 0,
        stop: false,
        arm() {
          state.visibleParts = visibleParts()
          state.armed = true
        },
      }
      ;(window as Window & { __historyRootProbe?: typeof state }).__historyRootProbe = state
      const sample = () => {
        if (state.armed) {
          const virtual = document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
          const viewport = virtual?.closest<HTMLElement>(".scroll-view__viewport")
          const view = viewport?.getBoundingClientRect()
          const visible = (partID: string) => {
            const part = viewport?.querySelector<HTMLElement>(`[data-timeline-part-id="${CSS.escape(partID)}"]`)
            const rect = part?.getBoundingClientRect()
            return (
              !!rect && !!view && rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
            )
          }
          if (!virtual || state.visibleParts.length === 0 || state.visibleParts.some((partID) => !visible(partID)))
            state.hidden = true
          state.samples++
        }
        if (!state.stop) requestAnimationFrame(() => setTimeout(sample, 0))
      }
      requestAnimationFrame(() => setTimeout(sample, 0))
    })

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await transport.waitForConnection()
    // Native assistants derive their turn root from earlier messages, not a
    // legacy parentID. Release the root page once its request is observable.
    await expect.poll(() => requests.filter((request) => request.phase === "start").length).toBe(2)
    expect(requests.filter((request) => request.phase === "end")).toHaveLength(1)
    history.resolve()
    await expectSessionTitle(page, title)
    await expect(page.locator(`[data-timeline-part-id="${lastPartID}"]`)).toBeVisible()
    await expect(page.locator(`[data-timeline-part-id="${userPartID}"]`)).toBeVisible()
    await expect(page.locator('[data-timeline-part-id^="msg_history_root_assistant_"]')).toHaveCount(assistants.length)
    await expect.poll(() => requests.filter((request) => request.phase === "end").length).toBe(2)
    expect(pages).toEqual([
      { before: undefined, limit: initialPageSize },
      { before: messages.at(-initialPageSize)!.id, limit: turnRootPageSize },
    ])
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
    await page.evaluate(() => {
      ;(window as Window & { __historyRootProbe?: { arm(): void } }).__historyRootProbe!.arm()
    })
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __historyRootProbe?: { samples: number } }).__historyRootProbe!.samples,
        ),
      )
      .toBeGreaterThan(0)
    const settlement =
      scenario === "completion"
        ? ended({ ...lastAssistant, time: { ...lastAssistant.time, completed: lastAssistant.time.created + 15000 } })
        : event("session.next.step.failed", {
            sessionID,
            timestamp: 1700000036000,
            assistantMessageID: lastAssistant.id,
            error: { type: "unknown", message: "Provider turn interrupted" },
          })
    const idle = status("idle")
    for (const payload of scenario === "interruption" ? [idle, settlement] : [settlement, idle]) {
      await transport.send(payload)
      await expect(page.locator(`[data-timeline-part-id="${lastPartID}"]`)).toBeVisible()
      await expect(page.locator('[data-timeline-part-id^="msg_history_root_assistant_"]')).toHaveCount(
        assistants.length,
      )
    }
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="bottom-spacer"]')).toBeVisible()
    if (scenario === "interruption")
      await expect(page.getByText("Provider turn interrupted", { exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => {
        const state = (window as Window & { __historyRootProbe?: { hidden: boolean; stop: boolean } })
          .__historyRootProbe!
        state.stop = true
        return state.hidden
      }),
    ).toBe(false)
  })
}
