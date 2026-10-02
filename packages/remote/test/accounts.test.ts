import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { accountDirectory, migrate, readAccounts, updateAccount } from "../src/accounts"
import { readJson } from "../src/file"
import { loadCredentials } from "../src/connectors/wechat/login"

const fixture = { directory: "" }

beforeEach(async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), "remote-accounts-"))
})

afterEach(async () => {
  await rm(fixture.directory, { recursive: true, force: true })
})

const legacy = {
  token: "bot-token",
  botID: "bot@im.bot",
  baseUrl: "https://ilinkai.example",
  userID: "owner@im.wechat",
  savedAt: 5,
  needsLogin: { at: 9, reason: "iLink returned -14" },
}

test("reads the single-WeChat file as one wechat account, then migrates files, state, and router keys", async () => {
  const authFile = path.join(fixture.directory, "remote-auth.json")
  const stateDir = path.join(fixture.directory, "state")
  await Bun.write(authFile, JSON.stringify({ wechat: legacy }))
  await mkdir(stateDir, { recursive: true })
  await Bun.write(path.join(stateDir, "wechat-bot_im.bot.cursor.json"), JSON.stringify({ cursor: "c9" }))
  await Bun.write(path.join(stateDir, "wechat-bot_im.bot.tokens.json"), JSON.stringify({}))
  await Bun.write(
    path.join(stateDir, "router.json"),
    JSON.stringify({
      version: 1,
      users: { "wechat:owner@im.wechat": { next: 3 }, "other:x": { next: 1 } },
      sessions: { ses_1: { local: true, driver: "wechat:owner@im.wechat" }, ses_2: { local: false } },
    }),
  )

  const before = await readAccounts(authFile)
  expect(before.wechat["bot@im.bot"]).toMatchObject({
    label: "微信 ClawBot",
    owner: "owner@im.wechat",
    needsLogin: legacy.needsLogin,
    credentials: { token: "bot-token", botID: "bot@im.bot", userID: "owner@im.wechat" },
  })
  expect(await loadCredentials(authFile)).toMatchObject({ botID: "bot@im.bot", needsLogin: legacy.needsLogin })

  expect(await migrate({ authFile, stateDir })).toBe(true)
  expect(await readAccounts(authFile)).toEqual(before)
  expect((await readJson(authFile)) as object).toEqual({ wechat: { "bot@im.bot": before.wechat["bot@im.bot"] } })
  expect((await stat(authFile)).mode & 0o777).toBe(0o600)
  const account = accountDirectory(stateDir, "wechat", "bot@im.bot")
  expect(account).toBe(path.join(stateDir, "wechat", "bot_im.bot"))
  expect(await readJson(path.join(account, "cursor.json"))).toEqual({ cursor: "c9" })
  expect((await readdir(stateDir)).sort()).toEqual(["router.json", "wechat"])
  const router = (await readJson(path.join(stateDir, "router.json"))) as {
    users: Record<string, unknown>
    sessions: Record<string, { driver?: string }>
  }
  expect(Object.keys(router.users).sort()).toEqual(["other:x", "wechat/bot@im.bot:owner@im.wechat"])
  expect(router.sessions.ses_1.driver).toBe("wechat/bot@im.bot:owner@im.wechat")
  expect(router.sessions.ses_2.driver).toBeUndefined()

  // Running again is a no-op.
  expect(await migrate({ authFile, stateDir })).toBe(false)
})

test("updates one account at a time without losing concurrent writes, and removes accounts", async () => {
  const authFile = path.join(fixture.directory, "remote-auth.json")
  await Promise.all(
    ["a", "b", "c"].map((id) =>
      updateAccount(authFile, "echo", id, () => ({ label: id, savedAt: 0, credentials: { id } })),
    ),
  )
  expect(Object.keys((await readAccounts(authFile)).echo).sort()).toEqual(["a", "b", "c"])
  await updateAccount(authFile, "echo", "b", () => undefined)
  expect(Object.keys((await readAccounts(authFile)).echo).sort()).toEqual(["a", "c"])
  expect(await readAccounts(path.join(fixture.directory, "missing.json"))).toEqual({})
})
