import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { PluginMarketplace } from "@/plugin/marketplace"

async function tmpdir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

const FILES: Array<[string, string]> = [
  ["skills/cut/SKILL.md", "---\nname: cut\ndescription: cut footage\n---\n# Cut"],
  ["commands/render.md", "render the timeline"],
  ["commands/nested/deep.md", "deep command"],
  ["agents/editor.md", "---\ndescription: video editor\n---\nEdit."],
]

async function makePluginDir(root: string, name = "video-kit") {
  const dir = path.join(root, name)
  for (const [relative, content] of FILES) {
    const file = path.join(dir, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  return dir
}

async function makeZip(root: string, wrap: string) {
  const writer = new ZipWriter(new BlobWriter())
  for (const [relative, content] of FILES) {
    await writer.add(`${wrap}/${relative}`, new TextReader(content))
  }
  return Buffer.from(await (await writer.close()).arrayBuffer())
}

const manifest = {
  name: "official",
  owner: { name: "someone" },
  plugins: [
    { name: "video-kit", source: "./video-kit", description: "video tools", version: "0.4.3", category: "media" },
    { name: "broken", description: "no source field" },
  ],
}

describe("PluginMarketplace.parseManifest", () => {
  it("keeps name+source entries and drops the rest", () => {
    const parsed = PluginMarketplace.parseManifest(manifest)
    expect(parsed.name).toBe("official")
    expect(parsed.plugins).toHaveLength(1)
    expect(parsed.plugins[0]).toMatchObject({ name: "video-kit", source: "./video-kit", version: "0.4.3" })
  })

  it("rejects manifests without a plugins array", () => {
    expect(() => PluginMarketplace.parseManifest({ name: "x" })).toThrow(/plugins array/)
  })
})

describe("PluginMarketplace.resolveSource", () => {
  it("classifies urls, absolute and rooted relative sources", () => {
    expect(PluginMarketplace.resolveSource(undefined, "https://cdn.example.com/p.zip")).toEqual({
      kind: "url",
      url: "https://cdn.example.com/p.zip",
    })
    expect(PluginMarketplace.resolveSource("/market", "./video-kit")).toEqual({
      kind: "dir",
      dir: "/market/video-kit",
    })
    expect(() => PluginMarketplace.resolveSource(undefined, "./video-kit")).toThrow(/no root/)
  })
})

describe("PluginMarketplace.install", () => {
  it("copies skills, commands and agents with nesting preserved", async () => {
    const root = await tmpdir("marketplace-src-")
    const pluginDir = await makePluginDir(root)
    const targets = {
      skills: path.join(root, "out", "skills"),
      commands: path.join(root, "out", "commands"),
      agents: path.join(root, "out", "agents"),
    }

    const installed = await PluginMarketplace.install(pluginDir, targets, false)
    expect(installed.skills).toEqual(["cut"])
    expect(installed.commands.sort()).toEqual(["nested/deep.md", "render.md"])
    expect(installed.agents).toEqual(["editor.md"])
    await expect(fs.readFile(path.join(targets.skills, "cut", "SKILL.md"), "utf8")).resolves.toContain("# Cut")
    await expect(
      fs.readFile(path.join(targets.commands, "nested", "deep.md"), "utf8"),
    ).resolves.toBe("deep command")

    const again = await PluginMarketplace.install(pluginDir, targets, false)
    expect(again.skipped).toHaveLength(4)
    const forced = await PluginMarketplace.install(pluginDir, targets, true)
    expect(forced.skipped).toHaveLength(0)
  })

  it("ignores skill folders without a SKILL.md", async () => {
    const root = await tmpdir("marketplace-partial-")
    const pluginDir = await makePluginDir(root)
    await fs.mkdir(path.join(pluginDir, "skills", "empty"), { recursive: true })
    const targets = {
      skills: path.join(root, "out", "skills"),
      commands: path.join(root, "out", "commands"),
      agents: path.join(root, "out", "agents"),
    }
    const installed = await PluginMarketplace.install(pluginDir, targets, false)
    expect(installed.skills).toEqual(["cut"])
  })
})

describe("PluginMarketplace.materialize", () => {
  it("downloads a zip and unwraps the wrap directory into the plugin root", async () => {
    const root = await tmpdir("marketplace-zip-")
    const bytes = await makeZip(root, "video-kit")
    const url = `data:application/zip;base64,${bytes.toString("base64")}`

    const dir = await PluginMarketplace.materialize({ fetch, tmp: root })({ kind: "url", url }, "video-kit")
    await expect(fs.readFile(path.join(dir, "skills", "cut", "SKILL.md"), "utf8")).resolves.toContain("# Cut")
    await expect(fs.readFile(path.join(dir, "commands", "nested", "deep.md"), "utf8")).resolves.toBe("deep command")
  })

  it("rejects a missing plugin directory", async () => {
    const root = await tmpdir("marketplace-missing-")
    await expect(
      PluginMarketplace.materialize({ fetch, tmp: root })({ kind: "dir", dir: path.join(root, "nope") }, "nope"),
    ).rejects.toThrow(/not found/)
  })
})
