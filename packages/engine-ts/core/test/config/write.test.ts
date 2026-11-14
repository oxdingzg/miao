import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { Effect, Exit } from "effect"
import { ConfigWrite } from "@miao/core/config/write"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Global } from "@miao/core/global"
import { tmpdir } from "../fixture/tmpdir"

const update = (directory: string, patch: Record<string, unknown>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const write = yield* ConfigWrite.Service
      return yield* write.updateGlobal(patch)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ConfigWrite.node]), [
          [Global.node, Global.layerWith({ config: directory })],
        ]),
      ),
    ),
  )

const read = async (file: string) => parse(await fs.readFile(file, "utf8"))

describe("ConfigWrite.updateGlobal", () => {
  test("creates miao.json and merges later patches, removing keys set to null", async () => {
    await using tmp = await tmpdir()
    const first = await update(tmp.path, { shell: "/bin/zsh", providers: { openai: { disabled: true } } })
    expect(Exit.isSuccess(first) && first.value).toMatchObject({
      changed: true,
      file: path.join(tmp.path, "miao.json"),
    })

    await update(tmp.path, { providers: { anthropic: { disabled: true } }, shell: null })
    expect(await read(path.join(tmp.path, "miao.json"))).toEqual({
      providers: { openai: { disabled: true }, anthropic: { disabled: true } },
    })

    const again = await update(tmp.path, { providers: { anthropic: { disabled: true } } })
    expect(Exit.isSuccess(again) && again.value.changed).toBe(false)
  })

  test("writes to the highest-priority existing file and keeps its comments", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "miao.json"), "{}\n")
    await fs.writeFile(path.join(tmp.path, "opencode.jsonc"), '{\n  // keep me\n  "model": "openai/gpt-5"\n}\n')

    await update(tmp.path, { shell: "/bin/bash" })

    const text = await fs.readFile(path.join(tmp.path, "opencode.jsonc"), "utf8")
    expect(text).toContain("// keep me")
    expect(parse(text)).toEqual({ model: "openai/gpt-5", shell: "/bin/bash" })
    expect(await fs.readFile(path.join(tmp.path, "miao.json"), "utf8")).toBe("{}\n")
  })

  test("migrates a V1 file to the V2 shape and keeps the original", async () => {
    await using tmp = await tmpdir()
    const original = '{\n  // v1\n  "model": "openai/gpt-5",\n  "permission": { "bash": "ask" }\n}\n'
    await fs.writeFile(path.join(tmp.path, "miao.jsonc"), original)

    const result = await update(tmp.path, { providers: { openai: { disabled: true } } })

    expect(Exit.isSuccess(result)).toBe(true)
    if (!Exit.isSuccess(result)) return
    expect(result.value.backup).toBeDefined()
    expect(await fs.readFile(result.value.backup!, "utf8")).toBe(original)
    const migrated = await read(path.join(tmp.path, "miao.jsonc"))
    expect(migrated).toMatchObject({ model: "openai/gpt-5", providers: { openai: { disabled: true } } })
    expect(migrated.permission).toBeUndefined()
    expect(migrated.permissions).toBeDefined()
  })

  test("rejects V1 keys and leaves the file untouched", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "miao.json"), '{ "shell": "/bin/zsh" }\n')

    const result = await update(tmp.path, { disabled_providers: ["openai"] })

    expect(Exit.isFailure(result)).toBe(true)
    expect(await fs.readFile(path.join(tmp.path, "miao.json"), "utf8")).toBe('{ "shell": "/bin/zsh" }\n')
  })

  test("refuses a change that no longer decodes as a configuration", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "miao.json"), '{ "shell": "/bin/zsh" }\n')

    const result = await update(tmp.path, { shell: 42 })

    expect(Exit.isFailure(result)).toBe(true)
    expect(await fs.readFile(path.join(tmp.path, "miao.json"), "utf8")).toBe('{ "shell": "/bin/zsh" }\n')
  })
})
