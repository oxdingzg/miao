import { expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { OpenCode } from "@miao/client"
import { Location } from "@miao/schema/location"
import { PermissionSaved } from "@miao/schema/permission-saved"
import { AbsolutePath } from "@miao/core/schema"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Saved = Schema.Struct({ data: Schema.Array(PermissionSaved.Info) })

test.skipIf(!binary)(
  "saved-permission HTTP API shows native scope and revokes only the selected directory",
  async () => {
    if (!binary) throw new Error("native engine required")
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    const other = path.join(tmp.path, "other")
    const root = path.join(tmp.path, "engines")
    await Promise.all([directory, other, root].map((directory) => mkdir(directory, { recursive: true })))
    const first = await realpath(directory)
    const second = await realpath(other)
    const seed = EngineClient.start({
      binary,
      db: SessionEnginePlacement.storageFor(root, Location.Ref.make({ directory: AbsolutePath.make(first) })),
      workspace: first,
      model: "fixture",
      provider: "openai-chat",
      endpoint: "http://127.0.0.1:9",
      env: { OPENAI_API_KEY: "fixture-only" },
    })
    const pattern = await seed.request("permission_pattern_put", {
      rule: { action: "read", resource: "public", effect: "allow" },
    })
    await seed.close()
    const stored = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, workspace: Schema.String }))(pattern)
    await using server = await serve(tmp.path, root, "native")
    const headers = (directory: string) => ({
      "content-type": "application/json",
      "x-opencode-directory": directory,
      authorization: "Basic " + btoa("fixture:fixture-password"),
    })
    const list = async (directory: string, query = "") => {
      const response = await fetch(`${server.url}/api/permission/saved${query}`, { headers: headers(directory) })
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(Saved)(await response.json()).data
    }
    const saved = await list(first)
    expect(saved).toHaveLength(1)
    const client = OpenCode.make({ baseUrl: server.url, headers: headers(first) })
    const created = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: headers(first),
      body: JSON.stringify({}),
    })
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
      await created.json(),
    )
    const unbound = await fetch(`${server.url}/api/session/${session.data.id}/permission`, {
      method: "POST",
      headers: headers(first),
      body: JSON.stringify({ action: "read", resources: ["public"] }),
    })
    expect(unbound.status).toBe(409)
    expect(await unbound.json()).toMatchObject({ _tag: "ConflictError", resource: session.data.id })
    const forged = await fetch(`${server.url}/api/session/${session.data.id}/permission`, {
      method: "POST",
      headers: headers(first),
      body: JSON.stringify({
        action: "read",
        resources: ["public"],
        source: { type: "tool", messageID: "msg_forged", callID: "call_forged" },
      }),
    })
    expect(forged.status).toBe(409)
    const pending = await fetch(`${server.url}/api/session/${session.data.id}/permission`, { headers: headers(first) })
    expect(pending.status).toBe(200)
    expect(await pending.json()).toMatchObject({ data: [] })
    expect(await client.permissions.listSaved()).toEqual(saved)
    expect(saved[0]).toEqual({
      id: PermissionSaved.ID.make(`${PermissionSaved.NativePrefix}${stored.id}`),
      projectID: saved[0].projectID,
      action: "read",
      resource: "public",
      origin: "native",
      scope: { type: "directory", directory: stored.workspace },
    })
    const { Database } = await import("bun:sqlite")
    const database = new Database(path.join(tmp.path, "miao-native.db"))
    database.run("PRAGMA busy_timeout = 5000")
    try {
      database
        .query(
          "INSERT INTO permission_legacy(id,project_id,action,resource,time_created,time_updated) VALUES(?1,?2,?3,?4,?5,?6)",
        )
        .run("psv_legacy_fixture", saved[0].projectID, "read", "legacy", Date.now(), Date.now())
    } finally {
      database.close()
    }
    expect((await list(first)).map((rule) => rule.resource).sort()).toEqual(["legacy", "public"])
    expect((await list(second)).map((rule) => rule.resource)).toEqual(["legacy"])
    expect(await list(first, "?projectID=proj_foreign")).toEqual([])
    const endpoint = `${server.url}/api/permission/saved/${saved[0].id}`
    expect((await fetch(endpoint, { method: "DELETE", headers: headers(second) })).status).toBe(204)
    expect((await list(first)).some((rule) => rule.id === saved[0].id)).toBe(true)
    expect((await fetch(endpoint, { method: "DELETE", headers: headers(first) })).status).toBe(204)
    expect((await list(first)).map((rule) => rule.resource)).toEqual(["legacy"])
    expect((await fetch(endpoint, { method: "DELETE", headers: headers(first) })).status).toBe(204)
    expect(await client.permissions.removeSaved({ id: saved[0].id })).toBeUndefined()
    await using legacyServer = await serve(tmp.path, root, "ts")
    expect(
      (
        await fetch(`${legacyServer.url}/api/permission/saved/${saved[0].id}`, {
          method: "DELETE",
          headers: headers(first),
        })
      ).status,
    ).toBe(409)
    const legacySession = await fetch(`${legacyServer.url}/api/session`, {
      method: "POST",
      headers: headers(first),
      body: JSON.stringify({}),
    })
    expect(legacySession.status).toBe(200)
    const legacyID = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
      await legacySession.json(),
    ).data.id
    const evaluated = await fetch(`${legacyServer.url}/api/session/${legacyID}/permission`, {
      method: "POST",
      headers: headers(first),
      body: JSON.stringify({ action: "read", resources: ["public"] }),
    })
    expect(evaluated.status).toBe(200)
    expect(await evaluated.json()).toMatchObject({ data: { effect: "allow" } })
    const legacyClient = OpenCode.make({ baseUrl: legacyServer.url, headers: headers(first) })
    await expect(legacyClient.permissions.removeSaved({ id: saved[0].id })).rejects.toMatchObject({
      _tag: "ConflictError",
      resource: saved[0].id,
    })
  },
  45_000,
)

async function serve(tmp: string, root: string, engine: "native" | "ts") {
  if (!binary) throw new Error("native engine required")
  const child = Bun.spawn(
    [process.execPath, "src/index.ts", "--engine", engine, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MIAO_DB: path.join(tmp, `miao-${engine}.db`),
        MIAO_ENGINE_BIN: binary,
        MIAO_ENGINE_STORAGE: engine === "ts" ? "" : root,
        MIAO_ENGINE_PROVIDER: "openai-chat",
        MIAO_ENGINE_MODEL: "fixture/fixture",
        MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:9",
        OPENAI_API_KEY: "fixture-only",
        MIAO_PURE: "1",
        MIAO_SERVER_USERNAME: "fixture",
        MIAO_SERVER_PASSWORD: "fixture-password",
        MIAO_TEST_HOME: path.join(tmp, engine, "home"),
        MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp, engine, "managed"),
        XDG_CONFIG_HOME: path.join(tmp, engine, "config"),
        XDG_DATA_HOME: path.join(tmp, engine, "data"),
        XDG_STATE_HOME: path.join(tmp, engine, "state"),
        XDG_CACHE_HOME: path.join(tmp, engine, "cache"),
        MIAO_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/fixture",
          permission: { "*": "allow" },
          formatter: false,
          lsp: false,
          providers: {
            fixture: {
              name: "Fixture",
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "http://127.0.0.1:9",
                settings: { apiKey: "fixture-only" },
              },
              models: { fixture: { name: "Fixture" } },
            },
          },
        }),
      },
    },
  )
  const stderr = new Response(child.stderr).text()
  const deadline = setTimeout(() => child.kill(), 35_000)
  try {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let url = ""
    while (!url) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`server exited: ${await stderr} ${output}`)
      output += decoder.decode(chunk.value, { stream: true })
      url = output.match(/miao server listening on (http:\/\/[^\s]+)/)?.[1] ?? ""
    }
    return {
      url,
      async [Symbol.asyncDispose]() {
        clearTimeout(deadline)
        child.kill()
        const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)])
        if (!exited) child.kill("SIGKILL")
        await child.exited
        await stderr
      },
    }
  } catch (error) {
    clearTimeout(deadline)
    child.kill()
    await child.exited
    throw error
  }
}
