import { expect, test } from "bun:test"
import path from "node:path"
import { realpath } from "node:fs/promises"
import { EngineClient } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native standing pattern RPCs keep ownership scoped across two processes",
  async () => {
    if (!binary) throw new Error("native engine required")
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "first")
    const other = path.join(tmp.path, "other")
    await Bun.$`mkdir -p ${directory} ${other}`.quiet()
    const options = {
      binary,
      db: path.join(tmp.path, "engine.db"),
      model: "fixture",
      provider: "openai-chat",
      env: { OPENAI_API_KEY: "fixture-only" },
    }
    const first = EngineClient.start({ ...options, workspace: directory })
    const clients = [first]
    try {
      expect(await first.request("permission_pattern_list")).toEqual([])
      const rule = { action: "read", resource: "*.rs", effect: "allow" }
      const stored = (await first.request("permission_pattern_put", { rule })) as {
        id: string
        workspace: string
        created_at_ms: number
      }
      expect(stored).toMatchObject({ source: "native", rule })
      expect(await realpath(stored.workspace)).toBe(await realpath(directory))
      expect(stored.created_at_ms).toBeGreaterThan(0)
      expect(await first.request("permission_pattern_put", { rule })).toEqual(stored)
      const second = EngineClient.start({ ...options, workspace: other })
      clients.push(second)
      expect(await second.request("permission_pattern_list")).toEqual([])
      const different = (await second.request("permission_pattern_put", { rule })) as { id: string }
      expect(different.id).not.toBe(stored.id)
      expect(await second.request("permission_pattern_remove", { rule_id: stored.id })).toEqual({ removed: false })
      expect(await second.request("permission_pattern_list")).toEqual([different])
      await expect(first.request("permission_pattern_put", { rule, workspace: other })).rejects.toBeInstanceOf(Error)
      await expect(
        first.request("permission_pattern_put", { rule: { ...rule, effect: "deny" } }),
      ).rejects.toBeInstanceOf(Error)
      const projected = Array.from({ length: 255 }, (_, index) => ({ ...rule, resource: `legacy-${index}` }))
      const projection = { workspace: stored.workspace, rules: projected }
      expect(await first.request("permission_saved_project", projection)).toEqual({ accepted: true })
      expect(await first.request("permission_saved_project", projection)).toEqual({ accepted: true })
      expect(await first.request("permission_pattern_put", { rule })).toEqual(stored)
      await expect(
        first.request("permission_pattern_put", { rule: { ...rule, resource: "native-over-budget" } }),
      ).rejects.toBeInstanceOf(Error)
      await expect(
        first.request("permission_saved_project", {
          workspace: stored.workspace,
          rules: [{ ...rule, resource: "legacy-over-budget" }],
        }),
      ).rejects.toBeInstanceOf(Error)
      expect(await first.request("permission_pattern_list")).toEqual([stored])
      expect(await first.request("permission_pattern_remove", { rule_id: stored.id })).toEqual({ removed: true })
      expect(await first.request("permission_pattern_remove", { rule_id: stored.id })).toEqual({ removed: false })
      expect(await first.request("permission_pattern_list")).toEqual([])
      expect(await second.request("permission_pattern_list")).toEqual([different])
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  },
  15_000,
)
