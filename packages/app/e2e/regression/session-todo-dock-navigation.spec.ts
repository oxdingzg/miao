import { base64Encode } from "@miao/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport, type SseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TodoDockNavigation"
const projectID = "proj_todo_dock_navigation"
const sourceID = "ses_todo_dock_source"
const otherID = "ses_todo_dock_other"
const sourceTitle = "Todo dock animation"
const otherTitle = "Separate session"

const activeTodos = [
  { id: "todo-1", content: "Receive todos in the active session", status: "completed", priority: "high" },
  { id: "todo-2", content: "Keep the dock visible across tabs", status: "completed", priority: "high" },
  { id: "todo-3", content: "Close after the final todo", status: "in_progress", priority: "high" },
]

type EventPayload = {
  id: string
  type: string
  location: { directory: string }
  data: Record<string, unknown>
}

let eventSequence = 0

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" })

test("animates todo lifecycle without replaying it across session tabs", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  let transport: SseTransport<EventPayload> | undefined
  const send = async (event: EventPayload) => {
    events.push(event)
    await transport?.send(event)
  }
  const todos: Record<string, typeof activeTodos> = { [sourceID]: [], [otherID]: [] }
  const sessionStatus: Record<string, { type: "busy" | "idle" }> = {}

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, sourceTitle, 1700000000000), session(otherID, otherTitle, 1700000001000)],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    sessionStatus: () => sessionStatus,
    todos: (sessionID) => todos[sessionID] ?? [],
  })
  await configurePage(page)
  transport = await installSseTransport<EventPayload>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 16,
  })

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  await transport.waitForConnection()
  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toHaveCount(0)

  sessionStatus[sourceID] = { type: "busy" }
  await send(statusEvent(sourceID, "busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

  await page.waitForTimeout(700)
  const opening = sampleDock(page, 1_000)
  todos[sourceID] = activeTodos
  await send(todoEvent(sourceID, activeTodos))
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  expect((await opening).some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95)).toBe(true)

  await switchSession(page, otherID, otherTitle)
  await expect(dock).toHaveCount(0)

  // Sample continuously from before the switch until the dock has shown, however long the switch
  // takes: a replayed opening animation would make the first sample that shows the dock partly
  // transparent.
  await startDockSampler(page)
  await switchSession(page, sourceID, sourceTitle)
  await expect(dock).toBeVisible()
  const openSamples = (await stopDockSampler(page, 3)).filter((sample) => sample.present)
  expect(openSamples.length).toBeGreaterThan(0)
  expect(openSamples[0]!.opacity).toBeGreaterThan(0.98)
  expect(openSamples[0]!.height).toBeGreaterThan(70)
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)

  const completedTodos = activeTodos.map((todo) => ({ ...todo, status: "completed" }))
  const closing = sampleDock(page, 1_000)
  todos[sourceID] = completedTodos
  await send(todoEvent(sourceID, completedTodos))
  await expect(dock).toHaveCount(0)
  expect((await closing).some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95)).toBe(true)
  todos[sourceID] = []
  await send(todoEvent(sourceID, []))

  await switchSession(page, otherID, otherTitle)
  await startDockSampler(page)
  await switchSession(page, sourceID, sourceTitle)
  await expect(dock).toHaveCount(0)
  // Keep sampling for a stretch after the switch, so a flash of the emptied dock is caught on a
  // slow runner as well.
  const returningEmpty = await stopDockSampler(page, 30)
  expect(returningEmpty.length).toBeGreaterThan(30)
  expect(returningEmpty.every((sample) => !sample.present)).toBe(true)
})

test("restores the todo dock from the server after a reload", async ({ page }) => {
  const todoRequests: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith("/todo")) todoRequests.push(path)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [session(sourceID, sourceTitle, 1700000000000), session(otherID, otherTitle, 1700000001000)],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sourceID]: { type: "busy" } },
    // No todo.updated event is replayed: the dock can only come from the persisted todo list.
    todos: (sessionID) => (sessionID === sourceID ? activeTodos : []),
  })
  await configurePage(page)

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)

  await page.reload()
  await expectSessionTitle(page, sourceTitle)
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  expect(todoRequests.filter((path) => path === `/api/session/${sourceID}/todo`).length).toBeGreaterThanOrEqual(2)
})

function session(id: string, title: string, created: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
  }
}

function statusEvent(sessionID: string, type: "busy" | "idle"): EventPayload {
  return {
    id: `evt_todo_dock_${String(++eventSequence).padStart(3, "0")}`,
    type: "session.next.status",
    location: { directory },
    data: { sessionID, timestamp: 1700000002000 + eventSequence * 100, status: { type } },
  }
}

function todoEvent(sessionID: string, next: typeof activeTodos): EventPayload {
  return {
    id: `evt_todo_dock_${String(++eventSequence).padStart(3, "0")}`,
    type: "todo.updated",
    location: { directory },
    data: { sessionID, todos: next },
  }
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionIDs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionIDs: [sourceID, otherID] },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

async function switchSession(page: Page, sessionID: string, title: string) {
  const href = sessionHref(sessionID)
  const tab = page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first()
  await expect(tab).toBeVisible()
  await tab.click()
  await expectSessionTitle(page, title)
}

type DockSample = { present: boolean; height: number; opacity: number }
type DockSamplerWindow = Window & { __dockSampler?: { samples: DockSample[]; stop: boolean } }

// Records the dock on a fixed ~16ms timer until stopped. Timer-driven rather than render-driven,
// so sampling keeps running (and finishes) even if the page renders no frames.
async function startDockSampler(page: Page) {
  await page.evaluate(() => {
    const state = { samples: [] as DockSample[], stop: false }
    ;(window as DockSamplerWindow).__dockSampler = state
    const sample = () => {
      const dock = document.querySelector<HTMLElement>('[data-component="session-todo-dock"]')
      const clip = dock?.parentElement?.parentElement
      const label = dock?.querySelector<HTMLElement>('[data-action="session-todo-toggle"] span[aria-label]')
      state.samples.push({
        present: !!dock,
        height: clip?.getBoundingClientRect().height ?? 0,
        opacity: label ? Number.parseFloat(getComputedStyle(label).opacity) : 0,
      })
    }
    const tick = () => {
      if (state.stop) return
      sample()
      setTimeout(tick, 16)
    }
    tick()
  })
}

async function stopDockSampler(page: Page, ticks: number) {
  return page.evaluate(async (ticks) => {
    const state = (window as DockSamplerWindow).__dockSampler!
    for (let index = 0; index < ticks; index++) await new Promise((resolve) => setTimeout(resolve, 16))
    state.stop = true
    return state.samples
  }, ticks)
}

function sampleDock(page: Page, duration: number) {
  return page.evaluate(async (duration) => {
    const samples: DockSample[] = []
    const start = performance.now()
    const next = () => new Promise((resolve) => setTimeout(resolve, 16))
    while (performance.now() - start < duration) {
      const dock = document.querySelector<HTMLElement>('[data-component="session-todo-dock"]')
      const clip = dock?.parentElement?.parentElement
      const label = dock?.querySelector<HTMLElement>('[data-action="session-todo-toggle"] span[aria-label]')
      samples.push({
        present: !!dock,
        height: clip?.getBoundingClientRect().height ?? 0,
        opacity: label ? Number.parseFloat(getComputedStyle(label).opacity) : 0,
      })
      await next()
    }
    return samples
  }, duration)
}
