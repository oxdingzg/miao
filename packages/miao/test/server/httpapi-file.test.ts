import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

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

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
