import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves V2 text and binary content with location metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello 世界\n")
    await Bun.write(path.join(tmp.path, "binary.bin"), new Uint8Array([0, 255, 1]))

    const text = await request("/api/fs/content", tmp.path, { path: "hello.txt" })
    expect(text.status).toBe(200)
    expect(await text.json()).toMatchObject({
      location: { directory: tmp.path },
      data: { type: "text", content: "hello 世界\n", encoding: "utf8", mime: "text/plain" },
    })

    const binary = await request("/api/fs/content", tmp.path, { path: "binary.bin" })
    expect(binary.status).toBe(200)
    expect(await binary.json()).toMatchObject({ data: { type: "binary", content: "AP8B", encoding: "base64" } })

    const escaped = await request("/api/fs/content", tmp.path, { path: "../outside.txt" })
    expect(escaped.status).toBe(500)
  })
})
