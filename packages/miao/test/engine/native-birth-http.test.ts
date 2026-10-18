import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native birth returns immediately readable engine metadata over HTTP", () => {})
if (binary)
  test("native birth returns immediately readable engine metadata over HTTP", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    await Bun.$`mkdir -p ${directory}`.quiet()
    const routesFile = path.join(tmp.path, "routes.json")
    await Bun.write(
      routesFile,
      JSON.stringify([
        {
          id: "account-two/shared",
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
          provider: "openai-chat",
          model: "fixture",
          endpoint: "http://127.0.0.1:1/private-route",
          credential: { type: "environment", key: "OPENAI_API_KEY" },
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
        MIAO_ENGINE_MODEL_ROUTES_CONFIG: routesFile,
        MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_TEST_HOME: path.join(tmp.path, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          providers: {
            fixture: {
              name: "Fixture",
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "http://127.0.0.1:1",
                settings: { apiKey: "fixture-only" },
              },
              models: { fixture: { name: "Fixture" }, other: { name: "Other" } },
            },
          },
          formatter: false,
          lsp: false,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      let output = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      let url = ""
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
      const body = { id: "ses_http_native_birth", location: { directory } }
      const create = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(create.status).toBe(200)
      const created = await create.json()
      expect(created.data.execution).toEqual({ engine: "rust", selection: "operator" })
      const get = await fetch(url + "/api/session/" + body.id, { headers })
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(created)
      const recoveryPath = url + "/api/session/" + body.id + "/recovery"
      expect((await fetch(recoveryPath)).status).toBe(401)
      const recoveries = await fetch(recoveryPath, { headers })
      expect(recoveries.status).toBe(200)
      expect(await recoveries.json()).toEqual({ data: { calls: [], hasMore: false } })
      const invalidRecovery = await fetch(recoveryPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ callID: "missing", operationID: "bad operation", decision: "retry" }),
      })
      expect(invalidRecovery.status).toBe(400)
      const unknownRecovery = await fetch(recoveryPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ callID: "missing", operationID: "op-missing", decision: "retry", resume: true }),
      })
      expect(unknownRecovery.status).toBe(409)
      expect(await unknownRecovery.text()).toContain("unknown tool outcome")
      const shell = await fetch(url + "/api/session/" + body.id + "/shell", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "echo native-ownership > escaped.txt", resume: false }),
      })
      expect(shell.status).toBe(409)
      expect(await shell.text()).toContain("session.shell")
      expect(await Bun.file(path.join(directory, "escaped.txt")).exists()).toBe(false)
      const model = await fetch(url + "/api/session/" + body.id + "/model", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "fixture", id: "other" } }),
      })
      expect(model.status).toBe(409)
      expect(await model.text()).toContain("native host route catalog")

      // Exact retry adopts the original engine identity, including title/time.
      const retry = await fetch(url + "/api/session", { method: "POST", headers, body: JSON.stringify(body) })
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual(created)
      const list = await fetch(url + "/api/session?directory=" + encodeURIComponent(directory), { headers })
      expect(list.status).toBe(200)
      expect((await list.json()).data).toEqual([created.data])
      const another = path.join(tmp.path, "another-project")
      await Bun.$`mkdir -p ${another}`.quiet()
      const anotherHeaders = { ...headers, "x-opencode-directory": another }
      const anotherBody = { id: "ses_http_native_other", location: { directory: another } }
      const createOther = await fetch(url + "/api/session", {
        method: "POST",
        headers: anotherHeaders,
        body: JSON.stringify(anotherBody),
      })
      expect(createOther.status).toBe(200)
      const other = await createOther.json()
      const listOther = await fetch(url + "/api/session?directory=" + encodeURIComponent(another), {
        headers: anotherHeaders,
      })
      expect(listOther.status).toBe(200)
      expect((await listOther.json()).data).toEqual([other.data])
      expect(Array.from(new Bun.Glob("*.db").scanSync(path.join(tmp.path, "engines")))).toHaveLength(2)
      // The guard protects TS fallback only: a supported native fork returns
      // before it and remains immediately readable with the right parent.
      const fork = await fetch(url + "/api/session/" + body.id + "/fork", { method: "POST", headers, body: "{}" })
      expect(fork.status).toBe(200)
      const forked = await fork.json()
      expect(forked.data.parentID).toBe(body.id)
      const childGet = await fetch(url + "/api/session/" + forked.data.id, { headers })
      expect(childGet.status).toBe(200)
      expect(await childGet.json()).toEqual(forked)
      const routesPath = url + "/api/session/" + body.id + "/model-routes"
      expect((await fetch(routesPath)).status).toBe(401)
      const routes = await fetch(routesPath, { headers })
      expect(routes.status).toBe(200)
      const catalog = await routes.json()
      expect(catalog).toEqual({
        data: [
          {
            model: { providerID: "native-engine-default", id: "default" },
            protocol: "openai-chat",
            wireModel: "fixture",
            default: true,
          },
          {
            model: { providerID: "native-engine", id: "account-two/shared" },
            variants: ["high"],
            protocol: "openai-chat",
            wireModel: "fixture",
            default: false,
          },
        ],
      })
      expect(JSON.stringify(catalog)).not.toContain("private-route")
      expect(JSON.stringify(catalog)).not.toContain("fixture-only")
      const modelPath = url + "/api/session/" + body.id + "/model"
      const selected = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: catalog.data[1].model }),
      })
      expect(selected.status).toBe(204)
      const selectedGet = await fetch(url + "/api/session/" + body.id, { headers })
      expect((await selectedGet.json()).data.model).toEqual(catalog.data[1].model)
      // CLI --model accepts product identifiers; the native picker continues
      // using its canonical route references. Both must select the same route.
      const productSelected = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "account-two", id: "shared" } }),
      })
      expect(productSelected.status).toBe(204)
      const productGet = await fetch(url + "/api/session/" + body.id, { headers })
      expect((await productGet.json()).data.model).toEqual(catalog.data[1].model)
      const variantSelected = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "account-two", id: "shared", variant: "high" } }),
      })
      expect(variantSelected.status).toBe(204)
      const variantGet = await fetch(url + "/api/session/" + body.id, { headers })
      expect((await variantGet.json()).data.model).toEqual({ ...catalog.data[1].model, variant: "high" })
      const unchanged = await fetch(url + "/api/session/" + anotherBody.id, { headers: anotherHeaders })
      expect((await unchanged.json()).data.model).toEqual(catalog.data[0].model)
      const inherited = await fetch(url + "/api/session/" + body.id + "/fork", { method: "POST", headers, body: "{}" })
      expect(inherited.status).toBe(200)
      expect((await inherited.json()).data.model).toEqual({ ...catalog.data[1].model, variant: "high" })
      const variant = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { ...catalog.data[1].model, variant: "missing" } }),
      })
      expect(variant.status).toBe(409)
      const unknown = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: "native-engine", id: "unregistered" } }),
      })
      expect(unknown.status).toBe(409)
      const reset = await fetch(modelPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: catalog.data[0].model }),
      })
      expect(reset.status).toBe(204)
      const resetGet = await fetch(url + "/api/session/" + body.id, { headers })
      expect((await resetGet.json()).data.model).toEqual(catalog.data[0].model)
      const imageFile = path.join(directory, "attachment.png")
      await Bun.write(
        imageFile,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          "base64",
        ),
      )
      const image = await fetch(url + "/api/session/" + body.id + "/prompt", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "msg_native_http_image",
          prompt: {
            text: "inspect the image",
            files: [
              {
                uri: pathToFileURL(imageFile).href,
                name: "http-image.png",
              },
            ],
          },
          resume: false,
        }),
      })
      expect(image.status).toBe(200)
      const admittedImage = await image.json()
      expect(admittedImage.data.prompt.files).toHaveLength(1)
      expect(admittedImage.data.prompt.files[0]).toMatchObject({ name: "http-image.png", mime: "image/png" })
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await stderr
    }
  }, 40_000)
