import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Inbound } from "../src/channel"
import { readJson } from "../src/file"
import { createWechatChannel, statePaths } from "../src/connectors/wechat/channel"
import { split } from "../src/text"
import { createFakeIlink, textMessage } from "../src/connectors/wechat/fake-ilink"
import { clientVersion, createLoginApi, parseLossless } from "../src/connectors/wechat/ilink"
import { loadCredentials, login, saveCredentials, type Credentials } from "../src/connectors/wechat/login"

const owner = "owner@im.wechat"

// Every request in these tests must stay on loopback; anything else is a bug in the code under test.
const localOnly = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "127.0.0.1") throw new Error(`test attempted a non-loopback request: ${url}`)
    return fetch(input, init)
  },
  { preconnect: () => undefined },
) satisfies typeof fetch

const fixture = {
  directory: "",
  fake: undefined as ReturnType<typeof createFakeIlink> | undefined,
}

beforeEach(async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), "remote-wechat-"))
  fixture.fake = createFakeIlink()
})

afterEach(async () => {
  fixture.fake?.stop()
  await rm(fixture.directory, { recursive: true, force: true })
})

function fake() {
  if (!fixture.fake) throw new Error("fake iLink not started")
  return fixture.fake
}

function credentials(): Credentials {
  return { token: "bot-token", botID: "bot@im.bot", baseUrl: fake().url, userID: owner, savedAt: 0 }
}

function channel(input: { credentials?: Credentials; pushBudgetPerDay?: number; pollTimeoutMs?: number } = {}) {
  return createWechatChannel({
    credentials: input.credentials ?? credentials(),
    stateDir: path.join(fixture.directory, "state"),
    authFile: path.join(fixture.directory, "auth.json"),
    agentVersion: "0.0.32",
    fetch: localOnly,
    pushBudgetPerDay: input.pushBudgetPerDay,
    retryDelayMs: 20,
    backoffMs: 50,
    typingIntervalMs: 20,
    pollTimeoutMs: input.pollTimeoutMs,
  })
}

function collector() {
  const received: Inbound[] = []
  return { received, onMessage: async (message: Inbound) => void received.push(message) }
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("condition not met in time")
}

describe("iLink protocol details", () => {
  test("keeps uint64 message ids exact and leaves string contents alone", () => {
    const parsed = parseLossless<{ msgs: Array<{ message_id: string; text: string }> }>(
      '{"msgs":[{"message_id": 18446744073709551615,"text":"\\"message_id\\": 1"}]}',
    )
    expect(parsed.msgs[0].message_id).toBe("18446744073709551615")
    expect(parsed.msgs[0].text).toBe('"message_id": 1')
  })

  test("encodes the client version as 0x00MMNNPP", () => {
    expect(clientVersion("2.4.9")).toBe(0x020409)
  })

  test("splits long text on code points and prefers line breaks", () => {
    expect(split("ab", 2)).toEqual(["ab"])
    expect(split("😀".repeat(5), 2)).toEqual(["😀😀", "😀😀", "😀"])
    const text = "x".repeat(90) + "\n" + "y".repeat(30)
    expect(split(text, 100)).toEqual(["x".repeat(90) + "\n", "y".repeat(30)])
  })
})

describe("QR login", () => {
  test("follows the redirect, retries a wrong verify code, refreshes an expired code, then saves credentials", async () => {
    const redirected = createFakeIlink()
    try {
      fake().status({ status: "wait" }, { status: "scaned_but_redirect", redirect_host: redirected.host })
      redirected.status(
        { status: "need_verifycode" },
        { status: "need_verifycode" },
        { status: "scaned" },
        { status: "expired" },
        {
          status: "confirmed",
          bot_token: "token-1",
          ilink_bot_id: "bot-1@im.bot",
          baseurl: "https://ilinkai.weixin.qq.com",
          ilink_user_id: owner,
        },
      )
      const shown: string[] = []
      const prompts: string[] = []
      const answers = ["111", "222"]
      const result = await login({
        api: createLoginApi({ baseUrl: fake().url, fetch: localOnly }),
        show: (content) => shown.push(content),
        ask: async (prompt) => {
          prompts.push(prompt)
          return answers.shift() ?? ""
        },
        say: () => undefined,
        pollDelayMs: 1,
        redirect: (host) => `http://${host}`,
      })
      expect(result).toEqual({
        ok: true,
        credentials: {
          token: "token-1",
          botID: "bot-1@im.bot",
          baseUrl: "https://ilinkai.weixin.qq.com",
          userID: owner,
          savedAt: expect.any(Number),
        },
      })
      expect(shown).toEqual(["https://qr.example/1", "https://qr.example/2"])
      expect(prompts).toEqual(["输入手机微信上显示的数字：", "数字不对，请重新输入："])
      const polls = redirected.requests.filter((request) => request.path === "/ilink/bot/get_qrcode_status")
      expect(polls.map((request) => request.query.get("verify_code"))).toEqual([null, "111", "222", null, null])
      expect(polls.at(-1)?.query.get("qrcode")).toBe("qr-2")
      expect(polls[0].headers["ilink-app-id"]).toBe("bot")
      expect(polls[0].headers["authorization"]).toBeUndefined()

      if (!result.ok) throw new Error("login failed")
      const file = path.join(fixture.directory, "auth.json")
      await saveCredentials(file, result.credentials)
      expect(await loadCredentials(file)).toEqual(result.credentials)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      redirected.stop()
    }
  })

  test("gives up after three expired codes", async () => {
    fake().status({ status: "expired" }, { status: "expired" }, { status: "expired" })
    const result = await login({
      api: createLoginApi({ baseUrl: fake().url, fetch: localOnly }),
      show: () => undefined,
      ask: async () => "",
      say: () => undefined,
      pollDelayMs: 1,
    })
    expect(result).toEqual({ ok: false, message: "二维码多次过期，已停止。请稍后重试" })
  })
})

describe("wechat channel", () => {
  test("polls with a persisted cursor, ignores strangers and duplicates, and survives drops and timeouts", async () => {
    const first = channel()
    const inbox = collector()
    const hello = textMessage({ from: owner, text: "hello", context: "ctx-a" })
    fake().update({ msgs: [hello], buf: "b1" })
    fake().update({ msgs: [hello, textMessage({ from: "stranger", text: "let me in" })], buf: "b2" })
    fake().update({ status: 503 })
    await first.start(inbox.onMessage)
    await eventually(() => inbox.received.length === 1)
    // Nothing scripted now: the poll is held open like the real long poll.
    await fake().until((request) => request.path === "/ilink/bot/getupdates" && request.body.get_updates_buf === "b2")
    fake().update({ msgs: [textMessage({ from: owner, text: "world", context: "ctx-b" })], buf: "b3" })
    await eventually(() => inbox.received.length === 2)
    await first.stop()

    expect(inbox.received.map((message) => [message.text, message.reply])).toEqual([
      ["hello", "ctx-a"],
      ["world", "ctx-b"],
    ])
    const polls = fake().requests.filter((request) => request.path === "/ilink/bot/getupdates")
    expect(polls.map((request) => request.body.get_updates_buf)).toEqual(["", "b1", "b2", "b2", "b3"])
    expect(polls[0].headers["authorizationtype"]).toBe("ilink_bot_token")
    expect(polls[0].headers["authorization"]).toBe("Bearer bot-token")
    expect(polls[0].headers["ilink-app-id"]).toBe("bot")
    expect(polls[0].headers["ilink-app-clientversion"]).toBe(String(0x020409))
    expect(Number(Buffer.from(polls[0].headers["x-wechat-uin"], "base64").toString())).toBeGreaterThanOrEqual(0)
    expect(polls[0].body.base_info).toEqual({ channel_version: "2.4.9", bot_agent: "miao/0.0.32" })

    const files = statePaths(path.join(fixture.directory, "state"))
    expect(await readJson(files.cursor)).toEqual({ cursor: "b3" })
    expect(await readJson(files.status)).toMatchObject({ state: "stopped" })

    // A restart resumes from the stored cursor rather than replaying from the start.
    const second = channel()
    const before = fake().requests.length
    await second.start(collector().onMessage)
    const resumed = await fake().until(
      (request) => request.path === "/ilink/bot/getupdates" && fake().requests.indexOf(request) >= before,
    )
    expect(resumed.body.get_updates_buf).toBe("b3")
    await second.stop()
  })

  test("a client-side long-poll timeout re-polls with the same cursor and honors the server's timeout hint", async () => {
    const wechat = channel({ pollTimeoutMs: 100 })
    const inbox = collector()
    fake().update({ msgs: [], buf: "c1", longpolling_timeout_ms: 150 })
    await wechat.start(inbox.onMessage)
    await eventually(() => fake().requests.filter((request) => request.body.get_updates_buf === "c1").length >= 2)
    fake().update({ msgs: [textMessage({ from: owner, text: "after timeouts" })], buf: "c2" })
    await eventually(() => inbox.received.length === 1)
    await wechat.stop()
    expect(inbox.received[0].text).toBe("after timeouts")
  })

  test("a stale token (-14) stops polling and marks the login as needing a new scan", async () => {
    const wechat = channel()
    fake().update({ ret: -14, errmsg: "session timeout" })
    await wechat.start(collector().onMessage)
    const files = statePaths(path.join(fixture.directory, "state"))
    await eventually(
      async () =>
        (await readJson(files.status).then((value) => (value as { state?: string })?.state)) === "needs-login",
    )
    await Bun.sleep(100)
    expect(fake().requests.filter((request) => request.path === "/ilink/bot/getupdates")).toHaveLength(1)
    const saved = await loadCredentials(path.join(fixture.directory, "auth.json"))
    expect(saved?.needsLogin?.reason).toContain("-14")
    await wechat.stop()
    await expect(channel({ credentials: saved }).start(collector().onMessage)).rejects.toThrow(
      "miao remote login wechat",
    )
  })

  test("only one channel may poll the same bot", async () => {
    const first = channel()
    await first.start(collector().onMessage)
    await expect(channel().start(collector().onMessage)).rejects.toThrow(`pid ${process.pid}`)
    await first.stop()
    const again = channel()
    await again.start(collector().onMessage)
    await again.stop()
  })

  test("sends 2000-character pieces with the latest context token and never retries a throttled send", async () => {
    const wechat = channel()
    const inbox = collector()
    fake().update({ msgs: [textMessage({ from: owner, text: "hi", context: "ctx-latest" })], buf: "b1" })
    await wechat.start(inbox.onMessage)
    await eventually(() => inbox.received.length === 1)

    fake().sendResult({ ret: 0 })
    const long = await wechat.send(owner, "a".repeat(4500))
    expect(long).toEqual({ ok: true, sent: 3 })
    const pieces = fake().sent()
    expect(pieces.map((message) => message.item_list.length)).toEqual([1, 1, 1])
    expect(pieces.map((message) => message.item_list[0].text_item.text.length)).toEqual([2000, 2000, 500])
    expect(pieces.every((message) => message.context_token === "ctx-latest" && message.to_user_id === owner)).toBe(true)
    expect(new Set(pieces.map((message) => message.client_id)).size).toBe(3)

    fake().sendResult({ ret: -2, errmsg: "prepare failed" })
    const throttled = await wechat.send(owner, "b".repeat(4500))
    expect(throttled).toEqual({ ok: false, sent: 0, error: "throttled (ret=-2)" })
    expect(fake().sent()).toHaveLength(4)

    await wechat.typing(owner, true)
    await eventually(() => fake().requests.filter((request) => request.path === "/ilink/bot/sendtyping").length >= 2)
    await wechat.typing(owner, false)
    const typing = fake().requests.filter((request) => request.path === "/ilink/bot/sendtyping")
    expect(typing.at(-1)?.body).toMatchObject({ ilink_user_id: owner, typing_ticket: "ticket-1", status: 2 })
    await wechat.stop()
  })
})
