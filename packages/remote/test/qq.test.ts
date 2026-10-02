import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Inbound } from "../src/channel"
import type { LoginStep } from "../src/connector"
import { readJson } from "../src/file"
import { createQQApi, Hosts } from "../src/connectors/qq/api"
import { bindLogin, connectUrl, decryptSecret, encryptSecret } from "../src/connectors/qq/bind"
import { createQQChannel, statePaths } from "../src/connectors/qq/channel"
import { createFakeQQ, type FakeQQ } from "../src/connectors/qq/fake-qq"
import { Intents, Op } from "../src/connectors/qq/gateway"
import { eventually, loopbackFetch } from "../src/testing"

const owner = "OWNER_OPENID"

const fixture = {
  directory: "",
  fake: undefined as FakeQQ | undefined,
  clock: 0,
  needsLogin: [] as string[],
}

beforeEach(async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), "remote-qq-"))
  fixture.fake = createFakeQQ()
  fixture.clock = 0
  fixture.needsLogin = []
})

afterEach(async () => {
  fixture.fake?.stop()
  await rm(fixture.directory, { recursive: true, force: true })
})

function fake() {
  if (!fixture.fake) throw new Error("fake QQ missing")
  return fixture.fake
}

const stateDir = () => path.join(fixture.directory, "account")

function channel(input: { owner?: string; markdown?: boolean } = {}) {
  return createQQChannel({
    credentials: { appId: fake().appId, secret: fake().secret },
    stateDir: stateDir(),
    owner: () => input.owner ?? owner,
    markNeedsLogin: async (reason) => void fixture.needsLogin.push(reason),
    api: fake().url,
    markdown: input.markdown,
    fetch: loopbackFetch,
    now: () => Date.now() + fixture.clock,
    reconnectMs: 20,
  })
}

function inbox() {
  const received: Inbound[] = []
  return { received, onMessage: async (message: Inbound) => void received.push(message) }
}

function loginContext(options: Record<string, unknown> = {}) {
  const abort = new AbortController()
  return {
    abort,
    context: {
      fetch: loopbackFetch,
      signal: abort.signal,
      options: { portal: fake().url, bind_poll_ms: 5, ...options },
      log: () => undefined,
      now: Date.now,
      sleep: (ms: number) => Bun.sleep(ms),
    },
  }
}

const identifies = () => fake().frames.filter((frame) => frame.op === Op.Identify)
const resumes = () => fake().frames.filter((frame) => frame.op === Op.Resume)

// The server marks a connection ready before the client has read READY; wait for the client side.
const sessionSaved = () =>
  eventually(async () =>
    Boolean(((await readJson(statePaths(stateDir()).gateway)) as { sessionID?: string } | undefined)?.sessionID),
  )

describe("QR binding", () => {
  test("refreshes an expired code, then decrypts the secret and names the scanner as owner", async () => {
    const { context } = loginContext()
    const steps: LoginStep[] = []
    for await (const step of bindLogin(context)) {
      steps.push(step)
      if (step.type !== "qr") continue
      if (fake().tasks().length === 1) fake().expireBind()
      else await fake().completeBind(owner)
    }
    expect(steps.map((step) => step.type)).toEqual(["qr", "progress", "qr", "done"])
    const first = steps[0]
    if (first.type !== "qr") throw new Error("expected a QR step")
    expect(first.content).toBe(`${fake().url}/qqbot/openclaw/connect.html?task_id=task-1&source=miao&_wv=2`)
    expect(connectUrl(Hosts.portal, "a b")).toBe(
      "https://q.qq.com/qqbot/openclaw/connect.html?task_id=a%20b&source=miao&_wv=2",
    )
    const done = steps.at(-1)
    expect(done).toMatchObject({
      type: "done",
      account: { id: fake().appId, label: "QQ 机器人" },
      owner,
      credentials: { appId: fake().appId, secret: fake().secret },
    })
    const created = fake().requests.filter((request) => request.path === "/lite/create_bind_task")
    expect(created).toHaveLength(2)
    expect(Buffer.from(String(created[0].body.key), "base64")).toHaveLength(32)
    expect(created[0].body.key).not.toBe(created[1].body.key)
    expect(
      fake()
        .requests.filter((request) => request.path === "/lite/poll_bind_result")
        .every((request) => request.body.task_id === "task-1" || request.body.task_id === "task-2"),
    ).toBe(true)
  })

  test("gives up after three refreshes", async () => {
    const { context } = loginContext()
    const steps: LoginStep[] = []
    for await (const step of bindLogin(context)) {
      steps.push(step)
      if (step.type === "qr") fake().expireBind()
    }
    expect(steps.filter((step) => step.type === "qr")).toHaveLength(4)
    expect(steps.at(-1)).toMatchObject({ type: "error", message: "二维码多次过期，已停止。请稍后重试" })
  })

  test("stops polling when cancelled", async () => {
    const { context, abort } = loginContext()
    const steps: LoginStep[] = []
    for await (const step of bindLogin(context)) {
      steps.push(step)
      abort.abort()
    }
    expect(steps.map((step) => step.type)).toEqual(["qr"])
  })

  test("AES-256-GCM secrets are IV(12) | ciphertext | tag(16) and fail under another key", async () => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    const sealed = await encryptSecret("s3cret", key)
    expect(Buffer.from(sealed, "base64")).toHaveLength(12 + 6 + 16)
    expect(await decryptSecret(sealed, key)).toBe("s3cret")
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    expect(decryptSecret(sealed, other)).rejects.toThrow()
  })
})

describe("OpenAPI client", () => {
  test("caches tokens with string lifetimes, refreshes ahead of expiry, and refetches after a 401", async () => {
    const clock = { now: 1_000_000 }
    fake().tokenLifetime("7200")
    const api = createQQApi({
      credentials: { appId: fake().appId, secret: fake().secret },
      api: fake().url,
      fetch: loopbackFetch,
      now: () => clock.now,
    })
    const [first, second] = await Promise.all([api.token(), api.token()])
    expect(first).toBe(second)
    expect(fake().tokensIssued()).toBe(1)
    clock.now += 7200_000 - 6 * 60_000
    expect(await api.token()).toBe(first)
    clock.now += 2 * 60_000
    expect(await api.token()).not.toBe(first)
    expect(fake().tokensIssued()).toBe(2)
    const token = fake().requests.find((request) => request.path === "/app/getAppAccessToken")
    expect(token?.body).toEqual({ appId: fake().appId, clientSecret: fake().secret })
  })

  test("without a configured host, falls back to the older hosts and sticks to the one that answered", async () => {
    const urls: string[] = []
    const offline = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        urls.push(url)
        if (url.startsWith(Hosts.api)) throw new Error("connection refused")
        if (url.endsWith("/app/getAppAccessToken")) return Response.json({ access_token: "t", expires_in: 7200 })
        return Response.json({ url: "wss://gateway.example/websocket" })
      },
      { preconnect: () => undefined },
    ) satisfies typeof fetch
    const api = createQQApi({ credentials: { appId: "1", secret: "s" }, fetch: offline })
    expect(await api.gatewayUrl()).toBe("wss://gateway.example/websocket")
    expect(await api.gatewayUrl()).toBe("wss://gateway.example/websocket")
    expect(urls).toEqual([
      `${Hosts.api}/app/getAppAccessToken`,
      `${Hosts.legacyToken}/app/getAppAccessToken`,
      `${Hosts.api}/gateway`,
      `${Hosts.legacyApi}/gateway`,
      `${Hosts.legacyApi}/gateway`,
    ])
  })
})

describe("gateway", () => {
  test("identifies with the C2C intent, heartbeats, and persists the session and seq", async () => {
    fake().stop()
    fixture.fake = createFakeQQ({ heartbeatMs: 30 })
    const qq = channel()
    await qq.start(inbox().onMessage)
    await fake().until(() => fake().connected())
    expect(identifies()[0].d).toMatchObject({ intents: Intents, shard: [0, 1] })
    expect(String((identifies()[0].d as { token: string }).token)).toMatch(/^QQBot token-\d+$/)
    await fake().until(() => fake().frames.some((frame) => frame.op === Op.Heartbeat))
    fake().c2c({ from: owner, text: "one", id: "m1" })
    await eventually(async () => (await readJson(statePaths(stateDir()).gateway)) !== undefined)
    await eventually(
      async () => ((await readJson(statePaths(stateDir()).gateway)) as { seq?: number } | undefined)?.seq === 2,
    )
    expect(await readJson(statePaths(stateDir()).gateway)).toEqual({ sessionID: "session-1", seq: 2 })
    expect(await readJson(statePaths(stateDir()).status)).toMatchObject({ state: "connected" })
    await qq.stop()
  })

  test("4009 and op 7 resume; 4006 and 4007 identify again with a fresh token; op 9 false identifies", async () => {
    const qq = channel()
    const box = inbox()
    await qq.start(box.onMessage)
    await sessionSaved()

    fake().close(4009)
    await fake().until(() => resumes().length === 1)
    expect(resumes()[0].d).toMatchObject({ session_id: "session-1", seq: 1 })
    await fake().until(() => fake().connected())

    fake().reconnect()
    await fake().until(() => resumes().length === 2)
    await fake().until(() => fake().connected())

    const tokens = fake().tokensIssued()
    fake().close(4006)
    await fake().until(() => identifies().length === 2)
    expect(fake().tokensIssued()).toBe(tokens + 1)
    await fake().until(() => fake().connected())

    fake().close(4007)
    await fake().until(() => identifies().length === 3)
    await fake().until(() => fake().connected())

    fake().invalidSession(false)
    await fake().until(() => identifies().length === 4)
    await fake().until(() => fake().connected())

    fake().c2c({ from: owner, text: "still here", id: "m-after" })
    await eventually(() => box.received.some((message) => message.text === "still here"))
    await qq.stop()
  })

  test("a restart resumes the persisted session", async () => {
    const first = channel()
    await first.start(inbox().onMessage)
    await sessionSaved()
    await first.stop()
    const second = channel()
    await second.start(inbox().onMessage)
    await fake().until(() => resumes().length === 1)
    expect(resumes()[0].d).toMatchObject({ session_id: "session-1" })
    await second.stop()
  })

  for (const code of [4914, 4915]) {
    test(`${code} stops reconnecting and marks the login as needing a new scan`, async () => {
      const qq = channel()
      await qq.start(inbox().onMessage)
      await fake().until(() => fake().connected())
      fake().close(code)
      await eventually(() => fixture.needsLogin.length === 1)
      expect(fixture.needsLogin[0]).toContain(String(code))
      await Bun.sleep(100)
      expect(identifies()).toHaveLength(1)
      expect(await readJson(statePaths(stateDir()).status)).toMatchObject({ state: "needs-login" })
      await qq.stop()
      expect(await readJson(statePaths(stateDir()).status)).toMatchObject({ state: "needs-login" })
    })
  }

  test("an unanswered heartbeat drops the half-open connection and resumes", async () => {
    fake().stop()
    fixture.fake = createFakeQQ({ heartbeatMs: 30 })
    const qq = channel()
    await qq.start(inbox().onMessage)
    await fake().until(() => fake().connected())
    fake().silent = true
    await fake().until(() => resumes().length >= 1, 5000)
    await qq.stop()
  })

  test("a second instance for the same bot is refused", async () => {
    const first = channel()
    await first.start(inbox().onMessage)
    expect(channel().start(inbox().onMessage)).rejects.toThrow(/另一个 miao remote/)
    await first.stop()
  })
})

describe("private messages", () => {
  test("accepts only the owner, de-duplicates by message id, and reads voice transcripts", async () => {
    const qq = channel()
    const box = inbox()
    await qq.start(box.onMessage)
    await fake().until(() => fake().connected())
    fake().c2c({ from: "SOMEONE_ELSE", text: "hi", id: "x1" })
    fake().c2c({ from: owner, text: " hello ", id: "a1" })
    fake().c2c({ from: owner, text: " hello ", id: "a1" })
    fake().c2c({
      from: owner,
      text: "",
      id: "v1",
      attachments: [{ content_type: "voice", asr_refer_text: "语音内容" }],
    })
    fake().c2c({ from: owner, text: "", id: "i1", attachments: [{ content_type: "image/png" }] })
    await eventually(() => box.received.length === 2)
    await eventually(() => fake().messages().length === 1)
    expect(box.received).toEqual([
      { user: owner, text: "hello", reply: "a1" },
      { user: owner, text: "语音内容", reply: "v1" },
    ])
    expect(fake().messages()[0]).toMatchObject({ to: owner, msg_id: "i1", markdown: { content: "暂时只支持文字消息" } })
    await qq.stop()
  })

  test("while pairing (no owner yet) every sender reaches the host gate", async () => {
    const qq = createQQChannel({
      credentials: { appId: fake().appId, secret: fake().secret },
      stateDir: stateDir(),
      owner: () => undefined,
      markNeedsLogin: async () => undefined,
      api: fake().url,
      fetch: loopbackFetch,
    })
    const box = inbox()
    await qq.start(box.onMessage)
    fake().c2c({ from: "ANYONE", text: "123456", id: "p1" })
    await eventually(() => box.received.length === 1)
    await qq.stop()
  })
})

describe("sending", () => {
  async function started(input: { markdown?: boolean } = {}) {
    const qq = channel(input)
    const box = inbox()
    await qq.start(box.onMessage)
    await fake().until(() => fake().connected())
    fake().c2c({ from: owner, text: "hi", id: "in-1" })
    await eventually(() => box.received.length === 1)
    return qq
  }

  test("replies passively with increasing msg_seq, then sends proactively once four replies are used", async () => {
    const qq = await started()
    for (const index of [1, 2, 3, 4, 5]) expect(await qq.send(owner, `r${index}`)).toEqual({ ok: true, sent: 1 })
    const sent = fake().messages()
    expect(sent.slice(0, 4).map((message) => [message.msg_id, message.msg_seq])).toEqual([
      ["in-1", 1],
      ["in-1", 2],
      ["in-1", 3],
      ["in-1", 4],
    ])
    expect(sent[4].msg_id).toBeUndefined()
    expect(sent[4]).toMatchObject({ msg_type: 2, markdown: { content: "r5" } })
    await qq.stop()
  })

  test("past five minutes a reply becomes a proactive message", async () => {
    const qq = await started()
    fixture.clock = 5 * 60_000 + 1
    expect(await qq.send(owner, "late")).toEqual({ ok: true, sent: 1 })
    expect(fake().messages().at(-1)?.msg_id).toBeUndefined()
    await qq.stop()
  })

  test("falls back to plain text when markdown is refused, and keeps using plain text", async () => {
    const qq = await started()
    fake().failSend({ err_code: 40034127, message: "无markdown模板权限" })
    expect(await qq.send(owner, "plain please")).toEqual({ ok: true, sent: 1 })
    expect(await qq.send(owner, "again")).toEqual({ ok: true, sent: 1 })
    const sent = fake().messages()
    expect(sent[0]).toMatchObject({ msg_type: 2, msg_seq: 1 })
    expect(sent[1]).toMatchObject({ msg_type: 0, content: "plain please", msg_id: "in-1", msg_seq: 2 })
    expect(sent[2]).toMatchObject({ msg_type: 0, content: "again" })
    await qq.stop()
    expect(await readJson(statePaths(stateDir()).sending)).toMatchObject({ markdown: false })
  })

  test("a refused passive reply is resent as a proactive message", async () => {
    const qq = await started()
    fake().failSend({ err_code: 40034128, message: "被动回复时间或次数超限" })
    expect(await qq.send(owner, "x")).toEqual({ ok: true, sent: 1 })
    expect(
      fake()
        .messages()
        .map((message) => message.msg_id),
    ).toEqual(["in-1", undefined])
    await qq.stop()
  })

  test("a user who refuses proactive messages (40054013) or a rate limit (40034100) fails the send", async () => {
    const qq = await started()
    fixture.clock = 10 * 60_000
    fake().failSend({ err_code: 40054013, message: "用户已拒收消息" })
    const refused = await qq.send(owner, "push")
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain("40054013")
    fake().failSend({ err_code: 40034100, message: "主动消息发送超过频控限制" })
    expect((await qq.send(owner, "push")).error).toContain("40034100")
    await qq.stop()
  })

  test("typing uses msg_type 6 inside the passive window and nothing outside it", async () => {
    const qq = await started()
    await qq.typing(owner, true)
    expect(fake().messages()[0]).toMatchObject({
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: "in-1",
      msg_seq: 1,
    })
    fixture.clock = 6 * 60_000
    await qq.typing(owner, true)
    await qq.typing(owner, false)
    expect(fake().messages()).toHaveLength(1)
    await qq.stop()
  })
})
