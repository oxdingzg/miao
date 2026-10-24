import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient } from "@/engine/client"
import { EngineSession } from "@/engine/session"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const real = binary ? test : test.skip

real("expired OAuth triggers its host owner and continues through the native inbox", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "credentials.db")
  const db = new Database(file)
  db.exec("CREATE TABLE credential(id TEXT PRIMARY KEY, integration_id TEXT, value TEXT)")
  const save = (access: string, expires: number) => db.query("INSERT OR REPLACE INTO credential VALUES(?,?,?)").run(
    "cred_fixture", "google", JSON.stringify({ type: "oauth", methodID: "google-account-browser", access, refresh: "fixture-refresh", expires }),
  )
  save("fixture-old", Date.now() + 3600_000)
  const seen: Array<string | null> = []
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.headers.get("authorization"))
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  const client = EngineClient.start({ binary: binary!, workspace: tmp.path, db: path.join(tmp.path, "engine.db"), provider: "openai-chat", model: "gemini-fixture", endpoint: new URL("chat/completions", provider.url).toString(), credentialDatabase: file, credentialID: "cred_fixture", credentialIntegration: "google", env: { MIAO_ENGINE_MODEL_ROUTES: "", MIAO_ENGINE_MODEL_ROUTES_CONFIG: "" } })
  let refreshes = 0
  let recovered = false
  const session = new EngineSession(client, (event) => {
    if (event.type === "session.next.text.ended" && typeof event.data === "object" && event.data !== null && "text" in event.data && event.data.text === "recovered") recovered = true
  }, undefined, async (input) => {
    expect(input).toEqual({ sessionID: "ses_expired_fixture", id: "cred_fixture", integration: "google" })
    expect(seen).toHaveLength(0)
    expect(JSON.parse(db.query<{ value: string }, []>("SELECT value FROM credential").get()!.value).access).toBe("fixture-expired")
    refreshes++
    save("fixture-fresh", Date.now() + 3600_000)
    return true
  })
  try {
    await client.request("initialize", { session_id: "ses_expired_fixture", title: "Expiry fixture" })
    save("fixture-expired", 1)
    await session.prompt("ses_expired_fixture", "Continue my task", { inputID: "input_fixture" })
    const deadline = Date.now() + 10000
    while (!recovered && Date.now() < deadline) await Bun.sleep(20)
    expect(recovered).toBe(true)
    expect(refreshes).toBe(1)
    expect(seen).toEqual(["Bearer fixture-fresh"])
  } finally {
    await client.close()
    provider.stop(true)
    db.close()
  }
}, 15000)
