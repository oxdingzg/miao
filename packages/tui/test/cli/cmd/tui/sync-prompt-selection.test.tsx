/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount } from "./sync-fixture"

const sessionID = "ses_prompt_selection"

async function sendWith(selection: { agent: string; providerID: string; modelID: string }) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const calls: { path: string; body: unknown }[] = []
  const { app, sync } = await mount((url, request) => {
    if (!url.pathname.startsWith(`/api/session/${sessionID}/`)) return undefined
    return (request ? request.clone().json() : Promise.resolve(undefined))
      .catch(() => undefined)
      .then((body) => {
        calls.push({ path: url.pathname, body })
        if (url.pathname.endsWith("/prompt")) return json({ data: { admittedSeq: 1 } })
        if (url.pathname.endsWith("/status")) return json({ data: { type: "idle" } })
        if (url.pathname.endsWith("/inputs")) return json({ data: [], hasMore: false })
        return new Response(null, { status: 204 })
      })
  }, tmp.path)
  try {
    sync.set("session", [
      {
        id: sessionID,
        agent: "build",
        model: { providerID: "opencode", id: "mimo-v2.6-flash-free" },
      } as never,
    ])
    await sync.prompt
      .send({
        sessionID,
        agent: selection.agent,
        model: { providerID: selection.providerID, modelID: selection.modelID },
        parts: [{ type: "text", text: "hello" }] as never,
      })
      .catch(() => undefined)
    return calls
  } finally {
    app.renderer.destroy()
  }
}

// Admission refreshes the status and the pending inbox instead of re-reading
// the transcript, so a send ends on those two reads. The selection still has
// to reach the server before the prompt itself.
test("a prompt applies the model picked after the session started before sending", async () => {
  const calls = await sendWith({ agent: "build", providerID: "tencent-token-plan", modelID: "glm-5.3-flash" })
  expect(calls.map((call) => call.path)).toEqual([
    `/api/session/${sessionID}/model`,
    `/api/session/${sessionID}/prompt`,
    `/api/session/${sessionID}/inputs`,
    `/api/session/${sessionID}/status`,
  ])
  expect(calls[0].body).toMatchObject({ model: { providerID: "tencent-token-plan", id: "glm-5.3-flash" } })
})

test("a prompt switches the agent only when it differs from the session", async () => {
  const calls = await sendWith({ agent: "plan", providerID: "opencode", modelID: "mimo-v2.6-flash-free" })
  expect(calls.map((call) => call.path)).toEqual([
    `/api/session/${sessionID}/agent`,
    `/api/session/${sessionID}/prompt`,
    `/api/session/${sessionID}/inputs`,
    `/api/session/${sessionID}/status`,
  ])
  expect(calls[0].body).toMatchObject({ agent: "plan" })
})
