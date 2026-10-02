// QQ bot channel: private (C2C) messages over the WebSocket gateway, replies
// over the OpenAPI.
//
// Sending policy, from the platform's "消息收发概述" (2026-07-21): a passive
// reply quotes the inbound msg_id and may be sent 4 times per inbound message
// within 60 minutes; the same page also says 5 minutes, so passive replies are
// only used within 5 minutes. Past that, or once the 4 replies are used, the
// message goes out as a proactive message (1000 per user per day, 20 per
// minute). Only when the user refused proactive messages (40054013) or the rate
// limit hit (40034100) does a send fail, and the Router then holds the result
// for the next inbound message.
import path from "node:path"
import type { Channel, Inbound } from "../../channel"
import { readJson, writer } from "../../file"
import { acquireLock, type Lock } from "../../lock"
import { deduper, split } from "../../text"
import { createQQApi, ErrorCode, MarkdownErrors, type Credentials, type SendBody } from "./api"
import { createGateway } from "./gateway"

export const MaxLength = 2000
export const PassiveWindowMs = 5 * 60_000
export const PassiveRepliesPerMessage = 4
export const ProactivePerDay = 1000
export const ProactivePerMinute = 20
const DedupWindowMs = 10 * 60_000

export type QQChannelOptions = {
  readonly credentials: Credentials
  /** This account's private directory: gateway session, reply windows, push counts, status, lock. */
  readonly stateDir: string
  /** The owner's openid; messages from anyone else never reach the Router. Undefined while pairing. */
  readonly owner: () => string | undefined
  readonly markNeedsLogin: (reason: string) => Promise<void>
  /** OpenAPI host; unset uses api.bot.qq.com with fallback to the older hosts. */
  readonly api?: string
  /** Send markdown first (default), falling back to plain text without permission. */
  readonly markdown?: boolean
  readonly fetch?: typeof fetch
  readonly log?: (message: string) => void
  readonly now?: () => number
  readonly reconnectMs?: number
}

type Window = { msgID: string; at: number; replies: number; seq: number }

type Stored = {
  windows: Record<string, Window>
  /** Proactive sends per user for the current local day. */
  pushes: { day: string; counts: Record<string, number> }
  markdown?: boolean
}

export function statePaths(stateDir: string) {
  return {
    gateway: path.join(stateDir, "gateway.json"),
    sending: path.join(stateDir, "sending.json"),
    status: path.join(stateDir, "status.json"),
    lock: path.join(stateDir, "lock"),
  }
}

export function createQQChannel(options: QQChannelOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const files = statePaths(options.stateDir)
  const onWriteError = (error: unknown) => log(`qq: failed to save state: ${String(error)}`)
  const saveGateway = writer(files.gateway, onWriteError)
  const saveSending = writer(files.sending, onWriteError)
  const saveStatus = writer(files.status, onWriteError)
  const api = createQQApi({ credentials: options.credentials, api: options.api, fetch: options.fetch, now, log })
  const fresh = deduper(DedupWindowMs, now)
  const recent = new Map<string, number[]>()
  const stored: Stored = { windows: {}, pushes: { day: "", counts: {} } }
  const runtime = {
    lock: undefined as Lock | undefined,
    status: undefined as { state: string; at: number; error?: string; lastPollAt?: number } | undefined,
    markdown: options.markdown !== false,
    gateway: undefined as ReturnType<typeof createGateway> | undefined,
  }

  const channel: Channel = {
    id: "qq",
    // No reply window for the Router: this channel itself turns late replies into proactive messages.
    capabilities: { buttons: false, push: true, maxLength: MaxLength },
    start: async (onMessage) => {
      const lock = await acquireLock(files.lock)
      if ("holder" in lock)
        throw new Error(`另一个 miao remote（pid ${lock.holder}）正在连接这个 QQ 机器人，同一个机器人只能有一个实例`)
      runtime.lock = lock
      const saved = (await readJson(files.sending)) as Partial<Stored> | undefined
      stored.windows = saved?.windows ?? {}
      stored.pushes = saved?.pushes ?? { day: "", counts: {} }
      if (saved?.markdown === false) runtime.markdown = false
      setStatus({ state: "starting", at: now() })
      runtime.gateway = createGateway({
        token: api.token,
        invalidateToken: api.invalidate,
        url: api.gatewayUrl,
        load: async () => {
          const value = (await readJson(files.gateway)) as { sessionID?: string; seq?: number } | undefined
          return value?.sessionID && typeof value.seq === "number"
            ? { sessionID: value.sessionID, seq: value.seq }
            : undefined
        },
        save: (session) => void saveGateway(() => session ?? {}),
        onDispatch: (type, data) => (type === "C2C_MESSAGE_CREATE" ? receive(data, onMessage) : undefined),
        onState: (state, error) =>
          setStatus({
            state: state === "connected" ? "connected" : state === "retrying" ? "retrying" : "starting",
            at: now(),
            lastPollAt: runtime.status?.lastPollAt,
            ...(error ? { error } : {}),
          }),
        onFatal: (reason) => {
          setStatus({ state: "needs-login", at: now(), error: reason })
          void options.markNeedsLogin(reason).catch(onWriteError)
        },
        log,
        reconnectMs: options.reconnectMs,
      })
      await runtime.gateway.start()
    },
    stop: async () => {
      await runtime.gateway?.stop()
      if (runtime.status?.state !== "needs-login") setStatus({ state: "stopped", at: now() })
      await saveStatus(() => runtime.status)
      await saveSending(() => ({ ...stored, markdown: runtime.markdown }))
      await runtime.lock?.release()
    },
    send: async (user, text) => {
      const pieces = split(text, MaxLength)
      const sent = { count: 0 }
      for (const piece of pieces) {
        const result = await deliver(user, piece)
        if (!result.ok) return { ok: false, sent: sent.count, error: result.error }
        sent.count += 1
      }
      return { ok: true, sent: sent.count }
    },
    typing: async (user, on) => {
      // QQ has no "stop typing"; the indicator simply times out.
      if (!on) return
      const window = openWindow(user)
      if (!window) return
      window.seq += 1
      await api
        .send(user, {
          msg_type: 6,
          input_notify: { input_type: 1, input_second: 60 },
          msg_id: window.msgID,
          msg_seq: window.seq,
        })
        .catch(() => undefined)
    },
  }

  return channel

  async function receive(data: unknown, onMessage: (message: Inbound) => Promise<void>) {
    const event = data as {
      id?: string
      content?: string
      author?: { user_openid?: string }
      attachments?: ReadonlyArray<{ content_type?: string; asr_refer_text?: string }>
    }
    const from = event.author?.user_openid ?? ""
    if (!event.id || !from) return
    const owner = options.owner()
    if (owner !== undefined && from !== owner) {
      log("qq: ignored a private message from someone who is not the owner")
      return
    }
    // The platform may push the same message more than once.
    if (!fresh(event.id)) return
    setStatus({ ...(runtime.status ?? { state: "connected", at: now() }), lastPollAt: now() })
    stored.windows[from] = { msgID: event.id, at: now(), replies: 0, seq: 0 }
    void saveSending(() => ({ ...stored, markdown: runtime.markdown }))
    const voice = (event.attachments ?? []).flatMap((item) => (item.asr_refer_text ? [item.asr_refer_text] : []))
    const text = [event.content ?? "", ...voice].join("\n").trim()
    if (!text) {
      await channel.send(from, "暂时只支持文字消息")
      return
    }
    await onMessage({ user: from, text, reply: event.id })
  }

  function openWindow(user: string) {
    const window = stored.windows[user]
    if (!window || now() - window.at >= PassiveWindowMs || window.replies >= PassiveRepliesPerMessage) return undefined
    return window
  }

  async function deliver(user: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const window = openWindow(user)
    if (!window) {
      const blocked = proactiveBlocked(user)
      if (blocked) return { ok: false, error: blocked }
    }
    if (window) window.seq += 1
    const body: SendBody = {
      ...(runtime.markdown ? { msg_type: 2, markdown: { content: text } } : { msg_type: 0, content: text }),
      ...(window ? { msg_id: window.msgID, msg_seq: window.seq } : {}),
    }
    const result = await api.send(user, body)
    if (result.ok) {
      if (window) window.replies += 1
      if (!window) countPush(user)
      await saveSending(() => ({ ...stored, markdown: runtime.markdown }))
      return { ok: true }
    }
    if (result.code !== undefined && MarkdownErrors.has(result.code) && runtime.markdown) {
      log(`qq: markdown refused (${result.code}); sending plain text from now on`)
      runtime.markdown = false
      return deliver(user, text)
    }
    const passiveSpent =
      result.code === ErrorCode.ReplyExpired ||
      result.code === ErrorCode.ReplyExhausted ||
      result.code === ErrorCode.ReplyInvalid
    if (window && passiveSpent) {
      log(`qq: passive reply refused (${result.code}); sending as a proactive message`)
      window.replies = PassiveRepliesPerMessage
      return deliver(user, text)
    }
    if (result.code === ErrorCode.Rejected) log("qq: the owner turned off proactive messages from this bot (40054013)")
    if (result.code === ErrorCode.Throttled) log("qq: proactive message rate limit hit (40034100)")
    return { ok: false, error: `${result.code ?? result.status} ${result.message}`.trim() }
  }

  function proactiveBlocked(user: string) {
    const today = day(now())
    const used = stored.pushes.day === today ? (stored.pushes.counts[user] ?? 0) : 0
    if (used >= ProactivePerDay) return `今天的主动消息已达上限（${ProactivePerDay}）`
    const minute = (recent.get(user) ?? []).filter((at) => now() - at < 60_000)
    recent.set(user, minute)
    if (minute.length >= ProactivePerMinute) return `主动消息过于频繁（每分钟 ${ProactivePerMinute} 条）`
    return undefined
  }

  function countPush(user: string) {
    const today = day(now())
    if (stored.pushes.day !== today) stored.pushes = { day: today, counts: {} }
    stored.pushes.counts[user] = (stored.pushes.counts[user] ?? 0) + 1
    recent.set(user, [...(recent.get(user) ?? []), now()])
  }

  function setStatus(status: { state: string; at: number; error?: string; lastPollAt?: number }) {
    runtime.status = status
    void saveStatus(() => runtime.status)
  }
}

function day(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}
