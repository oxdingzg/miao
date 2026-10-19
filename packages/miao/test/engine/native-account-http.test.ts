import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native account switching preserves the model and variant over HTTP", () => {})
if (binary)
  test("native account switching preserves the model and variant over HTTP", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const received: { path: string; authorization: string | null; body: string }[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        })
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const routes = path.join(tmp.path, "routes.json")
    await Bun.write(
      routes,
      JSON.stringify([
        {
          id: "host/model",
          provider: "openai-chat",
          model: "fixture",
          primary: true,
          endpoint: `http://127.0.0.1:${upstream.port}/a`,
          credential: { type: "environment", key: "OPENAI_API_KEY" },
          account: { id: "cred_default", model_key: "host/model", default: true },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
        },
        {
          id: "alternate",
          provider: "openai-chat",
          model: "fixture",
          endpoint: `http://127.0.0.1:${upstream.port}/b`,
          credential: { type: "environment", key: "ANTHROPIC_API_KEY" },
          account: { id: "cred_other", model_key: "host/model", default: false },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
        },
        {
          id: "wrong-family",
          provider: "openai-chat",
          model: "fixture",
          endpoint: `http://127.0.0.1:${upstream.port}/wrong`,
          credential: { type: "environment", key: "ANTHROPIC_API_KEY" },
          account: { id: "cred_other", model_key: "different/model", default: true },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
        },
        {
          id: "no-variant",
          provider: "openai-chat",
          model: "fixture",
          endpoint: `http://127.0.0.1:${upstream.port}/missing`,
          credential: { type: "environment", key: "ANTHROPIC_API_KEY" },
          account: { id: "cred_no_variant", model_key: "host/model", default: false },
        },
      ]),
    )
    const child = Bun.spawn([process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp.path, "miao.db"),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture",
        MIAO_ENGINE_ENDPOINT: `http://127.0.0.1:${upstream.port}/a`,
        MIAO_ENGINE_MODEL_ROUTES_CONFIG: routes,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "A_TOKEN",
        ANTHROPIC_API_KEY: "B_TOKEN",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      let output = ""
      let url = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      while (!url) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`native HTTP server exited: ${await stderr} ${output}`)
        output += decoder.decode(chunk.value)
        url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
      }
      const headers = {
        "x-opencode-directory": directory,
        "content-type": "application/json",
        authorization: "Basic " + btoa("fixture:fixture-password"),
      }
      const body = { id: "ses_native_account", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      if (create.status !== 200) throw new Error(`create failed ${create.status}: ${await create.text()}`)
      expect(create.status).toBe(200)
      expect((await create.json()).data.execution).toEqual({ engine: "rust", selection: "operator" })
      const sessionPath = url + "/api/session/" + body.id
      const switchAccount = (credentialID: string | null) =>
        fetch(sessionPath + "/account", { method: "POST", headers, body: JSON.stringify({ credentialID }) })
      expect((await fetch(sessionPath + "/account", { method: "POST" })).status).toBe(401)
      const model = await fetch(sessionPath + "/model", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "host", id: "model", variant: "high" } }),
      })
      expect(model.status).toBe(204)
      const prompt = (id: string) =>
        fetch(sessionPath + "/prompt", {
          method: "POST",
          headers,
          body: JSON.stringify({ id, prompt: { text: "answer" } }),
        })
      const waitFor = async (count: number) => {
        const deadline = Date.now() + 15000
        while (received.length < count && Date.now() < deadline) await Bun.sleep(20)
        expect(received.length).toBeGreaterThanOrEqual(count)
      }
      expect((await prompt("msg_account_one")).status).toBe(200)
      await waitFor(1)
      expect(received[0].path).toBe("/a")
      expect(received[0].authorization).toBe("Bearer A_TOKEN")
      const selected = await switchAccount("cred_other")
      if (selected.status !== 204) throw new Error(`${selected.status}: ${await selected.text()}`)
      const info = await (await fetch(sessionPath, { headers })).json()
      expect(info.data.credentialID).toBe("cred_other")
      expect(info.data.model.variant).toBe("high")
      // Updating the selected model/variant through its normal catalog id
      // preserves the account pin rather than moving back to the global default.
      expect(
        (
          await fetch(sessionPath + "/model", {
            method: "POST",
            headers,
            body: JSON.stringify({ model: { providerID: "host", id: "model", variant: "high" } }),
          })
        ).status,
      ).toBe(204)
      expect((await prompt("msg_account_two")).status).toBe(200)
      await waitFor(2)
      expect(received[1].path).toBe("/b")
      expect(received[1].authorization).toBe("Bearer B_TOKEN")
      expect(received[1].body).toContain('"reasoning_effort":"high"')
      expect((await switchAccount("cred_no_variant")).status).toBe(409)
      expect((await switchAccount("unknown")).status).toBe(409)
      expect((await (await fetch(sessionPath, { headers })).json()).data.credentialID).toBe("cred_other")
      expect((await switchAccount(null)).status).toBe(204)
      const cleared = await (await fetch(sessionPath, { headers })).json()
      expect(cleared.data.credentialID).toBeUndefined()
      expect(cleared.data.model.variant).toBe("high")
      expect((await prompt("msg_account_three")).status).toBe(200)
      await waitFor(3)
      expect(received[2].path).toBe("/a")
      expect(received[2].authorization).toBe("Bearer A_TOKEN")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
      await upstream.stop(true)
    }
  }, 70_000)
