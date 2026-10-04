/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_todo_clobber"

const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "todo clobber",
  agent: "build",
  model: { id: "model", providerID: "test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory },
  subpath: "",
}

const oldTodos = [{ content: "old", status: "pending", priority: "low" }]
const newTodos = [{ content: "new", status: "in_progress", priority: "high" }]

test("a full sync that started earlier does not revert a newer live todo update", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mount((url) => {
    if (url.pathname === "/api/session") return json({ data: [session] })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/status`) return json({ data: { type: "idle" } })
    // The stale snapshot resolves after the live event below.
    if (url.pathname === `/api/session/${sessionID}/todo`)
      return new Promise<Response>((resolve) => setTimeout(() => resolve(json({ data: oldTodos })), 80))
    return undefined
  }, tmp.path)

  const syncing = mounted.sync.session.sync(sessionID)

  mounted.emit({
    directory,
    project: "proj_test",
    payload: { id: "evt_todo_new", type: "todo.updated", properties: { sessionID, todos: newTodos } },
  })
  await wait(() => mounted.sync.data.todo[sessionID]?.[0]?.content === "new")

  await syncing
  expect(mounted.sync.data.todo[sessionID]?.[0]?.content).toBe("new")
})
