/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount } from "./sync-fixture"

const session = (id: string) => ({
  id,
  projectID: "proj_test",
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/tmp/opencode/packages/tui", workspaceID: undefined },
  subpath: "",
})

const message = (id: string) => ({
  id,
  type: "assistant" as const,
  time: { created: 1 },
  agent: "build",
  model: { id: "model", providerID: "test" },
  content: [{ type: "text" as const, id: `${id}_text`, text: "hi" }],
})

test("evicts the least recently used session beyond the retention cap", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let app: Awaited<ReturnType<typeof mount>>["app"] | undefined

  try {
    const mounted = await mount((url) => {
      const id = /^\/api\/session\/(ses_retention_\d+)(?:\/.*)?$/.exec(url.pathname)?.[1]
      if (url.pathname === "/api/session") return json({ data: [] })
      if (!id) return undefined
      if (url.pathname === `/api/session/${id}`) return json({ data: session(id) })
      if (url.pathname === `/api/session/${id}/context`) return json({ data: [message(`${id}_msg`)] })
      if (url.pathname === `/api/session/${id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${id}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${id}/diff`) return json({ data: [] })
      if (url.pathname === `/api/session/${id}/status`) return json({ data: { type: "idle" } })
      return undefined
    }, tmp.path)
    app = mounted.app

    const ids = Array.from({ length: 4 }, (_, index) => `ses_retention_${index}`)
    for (const id of ids) await mounted.sync.session.sync(id)

    const retained = Object.keys(mounted.sync.data.message)
    expect(retained.length).toBe(3)
    expect(retained).not.toContain("ses_retention_0")
    expect(retained).toContain("ses_retention_3")
  } finally {
    app?.renderer.destroy()
  }
})

test("text budget evicts idle history while preserving the displayed session", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mount((url) => {
    const id = /^\/api\/session\/(ses_budget_\d+)(?:\/.*)?$/.exec(url.pathname)?.[1]
    if (url.pathname === "/api/session") return json({ data: [] })
    if (!id) return undefined
    if (url.pathname === `/api/session/${id}`) return json({ data: session(id) })
    if (url.pathname === `/api/session/${id}/context`)
      return json({
        data: [{ ...message(`${id}_msg`), content: [{ type: "text", id: `${id}_text`, text: "x".repeat(1_200_000) }] }],
      })
    if (url.pathname === `/api/session/${id}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${id}/todo` || url.pathname === `/api/session/${id}/diff`)
      return json({ data: [] })
    if (url.pathname === `/api/session/${id}/status`) return json({ data: { type: "idle" } })
    return undefined
  }, tmp.path)
  try {
    mounted.sync.session.pin("ses_budget_0")
    await mounted.sync.session.sync("ses_budget_0")
    await mounted.sync.session.sync("ses_budget_1")
    expect(mounted.sync.data.message.ses_budget_0).toHaveLength(1)
    mounted.sync.session.unpin("ses_budget_1")
    expect(mounted.sync.data.message.ses_budget_1).toBeUndefined()
    expect(mounted.sync.data.part.ses_budget_1_msg).toBeUndefined()
    expect(mounted.sync.data.message.ses_budget_0).toHaveLength(1)
    await mounted.sync.session.sync("ses_budget_1")
    expect(mounted.sync.data.message.ses_budget_1).toHaveLength(1)
    mounted.sync.session.pin("ses_budget_1")
    mounted.sync.session.unpin("ses_budget_0")
    expect(mounted.sync.data.message.ses_budget_0).toBeUndefined()
    expect(mounted.sync.data.message.ses_budget_1).toHaveLength(1)
  } finally {
    mounted.app.renderer.destroy()
  }
})
