// WeChat (iLink) channel: long-polls getupdates with a persisted cursor, accepts
// only the person who scanned the login code, de-duplicates retransmissions,
// remembers the latest context_token per user, and sends text in 2000-character
// pieces. Rate-limit behavior follows community measurements recorded in
// specs/remote-im.md: replies within ~2 minutes of an inbound message, about 10
// per context token, and a few proactive pushes per day.
import path from "node:path"
import type { Channel, Inbound, SendResult } from "../../channel"
import { readJson, writer } from "../../file"
import { acquireLock, type Lock } from "../../lock"
import { split } from "../../text"
import { createIlinkApi, ItemType, MessageType, StaleTokenCode, ThrottledCode, type WeixinMessage } from "./ilink"
import { saveCredentials, type Credentials } from "./login"

export const ReplyWindowMs = 120_000
export const MaxLength = 2000
const DedupWindowMs = 5 * 60_000
const TicketTtlMs = 24 * 60 * 60_000

export type WechatStatus = {
  readonly state: "starting" | "polling" | "retrying" | "needs-login" | "stopped"
  readonly at: number
  readonly lastPollAt?: number
  readonly error?: string
}

export type WechatChannelOptions = {
  readonly credentials: Credentials
  /** This account's private directory for the cursor, context tokens, status, and the single-instance lock. */
  readonly stateDir: string
  /** Records a stale token so the account stays off until a new QR login. */
  readonly markNeedsLogin?: (reason: string) => Promise<void>
  /** Credentials file updated with needsLogin when no markNeedsLogin is given. */
  readonly authFile?: string
  readonly agentVersion: string
  readonly pushBudgetPerDay?: number
  readonly fetch?: typeof fetch
  readonly log?: (message: string) => void
  readonly now?: () => number
  readonly retryDelayMs?: number
  readonly backoffMs?: number
  readonly typingIntervalMs?: number
  readonly pollTimeoutMs?: number
}

export function statePaths(stateDir: string) {
  return {
    cursor: path.join(stateDir, "cursor.json"),
    tokens: path.join(stateDir, "tokens.json"),
    status: path.join(stateDir, "status.json"),
    lock: path.join(stateDir, "lock"),
  }
}

export function createWechatChannel(options: WechatChannelOptions) {
  const credentials = options.credentials
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const api = createIlinkApi({
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    agentVersion: options.agentVersion,
    fetch: options.fetch,
  })
  const files = statePaths(options.stateDir)
  const onWriteError = (error: unknown) => log(`wechat: failed to save state: ${String(error)}`)
  const saveCursor = writer(files.cursor, onWriteError)
  const saveTokens = writer(files.tokens, onWriteError)
  const saveStatus = writer(files.status, onWriteError)
  const seen = new Map<string, number>()
  const tokens = new Map<string, { token: string; at: number }>()
  const tickets = new Map<string, { ticket: string; at: number }>()
  const typing = new Map<string, ReturnType<typeof setInterval>>()
  const abort = new AbortController()
  const runtime = {
    cursor: "",
    lock: undefined as Lock | undefined,
    loop: Promise.resolve(),
    status: undefined as WechatStatus | undefined,
  }

  const channel: Channel = {
    id: "wechat",
    capabilities: {
      buttons: false,
      push: true,
      maxLength: MaxLength,
      pushBudgetPerDay: options.pushBudgetPerDay ?? 4,
      replyWindowMs: ReplyWindowMs,
      repliesPerInbound: 10,
    },
    start: async (onMessage) => {
      if (credentials.needsLogin) throw new Error("微信登录已失效，请运行 miao remote login wechat 重新扫码")
      const lock = await acquireLock(files.lock)
      if ("holder" in lock)
        throw new Error(`另一个 miao remote（pid ${lock.holder}）正在轮询这个微信 bot，同一个 bot 只能有一个实例`)
      runtime.lock = lock
      runtime.cursor = String(field(await readJson(files.cursor), "cursor") ?? "")
      const stored = await readJson(files.tokens)
      Object.entries(typeof stored === "object" && stored !== null ? stored : {}).forEach(([user, value]) => {
        const token = field(value, "token")
        const at = field(value, "at")
        if (typeof token === "string" && typeof at === "number") tokens.set(user, { token, at })
      })
      setStatus({ state: "starting", at: now() })
      void api.notifyStart().catch((error: unknown) => log(`wechat: notifystart failed: ${String(error)}`))
      runtime.loop = poll(onMessage)
    },
    stop: async () => {
      abort.abort()
      typing.forEach((timer) => clearInterval(timer))
      typing.clear()
      await runtime.loop
      await api.notifyStop().catch(() => undefined)
      if (runtime.status?.state !== "needs-login") setStatus({ state: "stopped", at: now() })
      await saveStatus(() => runtime.status)
      await runtime.lock?.release()
    },
    send: (user, text, reply) => send(user, text, typeof reply === "string" ? reply : undefined),
    typing: async (user, on) => {
      const existing = typing.get(user)
      if (existing) clearInterval(existing)
      typing.delete(user)
      const ticket = await typingTicket(user)
      if (!ticket) return
      if (!on) {
        await api.sendTyping(user, ticket, false).catch(() => undefined)
        return
      }
      await api.sendTyping(user, ticket, true).catch(() => undefined)
      const timer = setInterval(() => {
        // Typing only means something while a reply can still follow.
        if (now() - (tokens.get(user)?.at ?? 0) >= ReplyWindowMs) {
          clearInterval(timer)
          typing.delete(user)
          void api.sendTyping(user, ticket, false).catch(() => undefined)
          return
        }
        void api.sendTyping(user, ticket, true).catch(() => undefined)
      }, options.typingIntervalMs ?? 5000)
      typing.set(user, timer)
    },
  }

  return channel

  async function poll(onMessage: (message: Inbound) => Promise<void>) {
    const state = { timeout: options.pollTimeoutMs ?? 35_000, failures: 0 }
    while (!abort.signal.aborted) {
      const result = await api
        .getUpdates(runtime.cursor, state.timeout, abort.signal)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
      if (abort.signal.aborted) return
      const failure = !result.ok
        ? result.error
        : (result.value.ret ?? 0) !== 0 || (result.value.errcode ?? 0) !== 0
          ? `ret=${result.value.ret} errcode=${result.value.errcode} ${result.value.errmsg ?? ""}`.trim()
          : undefined
      if (result.ok && (result.value.ret === StaleTokenCode || result.value.errcode === StaleTokenCode)) {
        // The token is dead; polling again only repeats the error. A new QR login is required.
        log("wechat: iLink reported the bot token stale (-14); polling stopped, run `miao remote login wechat`")
        setStatus({ state: "needs-login", at: now(), error: failure })
        const reason = "iLink returned -14 (session timeout)"
        const authFile = options.authFile
        await (
          options.markNeedsLogin
            ? options.markNeedsLogin(reason)
            : authFile
              ? saveCredentials(authFile, { ...credentials, needsLogin: { at: now(), reason } })
              : Promise.resolve()
        ).catch(onWriteError)
        return
      }
      if (failure !== undefined) {
        state.failures += 1
        log(`wechat: getupdates failed (${state.failures}): ${failure}`)
        setStatus({ state: "retrying", at: now(), lastPollAt: runtime.status?.lastPollAt, error: failure })
        const backoff = state.failures >= 3
        if (backoff) state.failures = 0
        await sleep(backoff ? (options.backoffMs ?? 30_000) : (options.retryDelayMs ?? 2000))
        continue
      }
      if (!result.ok) continue
      state.failures = 0
      const response = result.value
      if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0)
        state.timeout = response.longpolling_timeout_ms
      for (const message of response.msgs ?? []) await receive(message, onMessage)
      // Advance the cursor only after the batch was handed over, so a crash
      // re-delivers instead of dropping; de-duplication absorbs the repeat.
      if (response.get_updates_buf) {
        runtime.cursor = response.get_updates_buf
        await saveCursor(() => ({ cursor: runtime.cursor }))
      }
      setStatus({ state: "polling", at: now(), lastPollAt: now() })
    }
  }

  async function receive(message: WeixinMessage, onMessage: (message: Inbound) => Promise<void>) {
    if (message.message_type === MessageType.Bot) return
    const from = message.from_user_id ?? ""
    if (from !== credentials.userID) {
      log(
        `wechat: ignored message from ${from || "unknown sender"}; only the account that scanned the login code is accepted`,
      )
      return
    }
    const key = [from, message.message_id ?? "", message.seq ?? "", message.create_time_ms ?? ""].join("|")
    const cutoff = now() - DedupWindowMs
    seen.forEach((at, entry) => {
      if (at < cutoff) seen.delete(entry)
    })
    if (seen.has(key)) return
    seen.set(key, now())
    if (message.context_token) {
      tokens.set(from, { token: message.context_token, at: now() })
      await saveTokens(() => Object.fromEntries(tokens))
    }
    const text = (message.item_list ?? [])
      .flatMap((item) =>
        item.type === ItemType.Text
          ? [item.text_item?.text ?? ""]
          : item.type === ItemType.Voice
            ? [item.voice_item?.text ?? ""]
            : [],
      )
      .join("\n")
      .trim()
    if (!text) {
      await send(from, "暂时只支持文字消息（语音请开启转文字）", message.context_token)
      return
    }
    await onMessage({ user: from, text, reply: message.context_token })
  }

  async function send(user: string, text: string, contextToken: string | undefined): Promise<SendResult> {
    const token = contextToken ?? tokens.get(user)?.token
    if (!token) log(`wechat: no context_token for ${user}; sending without one`)
    const chunks = split(text, MaxLength)
    const sent = { count: 0 }
    for (const chunk of chunks) {
      const clientID = `miao-${crypto.randomUUID()}`
      const result = await api
        .sendText({ to: user, text: chunk, contextToken: token, clientID })
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
      if (!result.ok) return { ok: false, sent: sent.count, error: result.error }
      const ret = result.value.ret ?? 0
      // -2 is iLink's send throttle; every attempt during the penalty extends it, so never retry.
      if (ret === ThrottledCode) {
        log("wechat: sendmessage throttled by iLink (ret=-2); not retrying")
        return { ok: false, sent: sent.count, error: "throttled (ret=-2)" }
      }
      if (ret !== 0) return { ok: false, sent: sent.count, error: `ret=${ret} ${result.value.errmsg ?? ""}`.trim() }
      if (!result.value.message_id)
        log(`wechat: sendmessage returned no message_id for ${clientID}; delivery is uncertain`)
      sent.count += 1
    }
    return { ok: true, sent: sent.count }
  }

  async function typingTicket(user: string) {
    const cached = tickets.get(user)
    if (cached && now() - cached.at < TicketTtlMs) return cached.ticket
    const response = await api.getConfig(user, tokens.get(user)?.token).catch(() => undefined)
    if (!response || (response.ret ?? 0) !== 0 || !response.typing_ticket) return cached?.ticket
    tickets.set(user, { ticket: response.typing_ticket, at: now() })
    return response.typing_ticket
  }

  function setStatus(status: WechatStatus) {
    runtime.status = status
    void saveStatus(() => runtime.status)
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}
