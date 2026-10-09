import { expect, test } from "bun:test"
import { chmod, mkdtemp, symlink, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ControlClientSettings } from "../src/client-settings"

async function fixture(action: (filename: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "miao-control-settings-"))
  try {
    await action(path.join(root, "client.json"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test("loads a private operator default and normalizes only its origin", () =>
  fixture(async (file) => {
    await writeFile(file, JSON.stringify({ defaultHubURL: "https://relay.example.invalid/" }), { mode: 0o600 })
    expect(await ControlClientSettings.read(file)).toEqual({ defaultHubURL: "https://relay.example.invalid" })
  }))
test("missing settings leave custom/self-hosted selection available", () =>
  fixture(async (file) => {
    expect(await ControlClientSettings.read(file)).toEqual({})
  }))
test("explicit environment overrides the private default", () =>
  fixture(async (file) => {
    expect(await ControlClientSettings.read(file, "https://other.example.invalid")).toEqual({
      defaultHubURL: "https://other.example.invalid",
    })
  }))
test("rejects credential-bearing, path and non-HTTPS defaults", () =>
  fixture(async (file) => {
    for (const defaultHubURL of [
      "http://relay.example.invalid",
      "https://user:secret@relay.example.invalid",
      "https://relay.example.invalid/path",
    ]) {
      await writeFile(file, JSON.stringify({ defaultHubURL }), { mode: 0o600 })
      await expect(ControlClientSettings.read(file)).rejects.toThrow("root HTTPS")
    }
  }))
test("rejects unknown credential fields instead of persisting account secrets", () =>
  fixture(async (file) => {
    await writeFile(file, JSON.stringify({ defaultHubURL: "https://relay.example.invalid", password: "private" }), {
      mode: 0o600,
    })
    await expect(ControlClientSettings.read(file)).rejects.toThrow("Invalid Remote")
  }))
test.skipIf(process.platform === "win32")("rejects shared files and symlink targets", () =>
  fixture(async (file) => {
    await writeFile(file, "{}", { mode: 0o600 })
    await chmod(file, 0o644)
    await expect(ControlClientSettings.read(file)).rejects.toThrow("owner-only")
    await chmod(file, 0o600)
    const link = file + ".link"
    await symlink(file, link)
    await expect(ControlClientSettings.read(link)).rejects.toThrow()
  }),
)
