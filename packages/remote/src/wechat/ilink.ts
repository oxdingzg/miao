// Minimal client for the WeChat iLink bot HTTP API, following the official
// @tencent-weixin/openclaw-weixin 2.4.9 plugin (src/api/api.ts) and its
// docs/protocol_zh_CN.md. Only text messaging, typing, and QR login are covered.

export const DefaultBaseUrl = "https://ilinkai.weixin.qq.com"

/** Protocol version this client was verified against; reported as channel_version and the client version header. */
export const ProtocolVersion = "2.4.9"

export const MessageType = { User: 1, Bot: 2 } as const
export const ItemType = { Text: 1, Image: 2, Voice: 3, File: 4, Video: 5 } as const
export const StaleTokenCode = -14
export const ThrottledCode = -2

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect"

export type QrStatusResponse = {
  readonly status: QrStatus
  readonly bot_token?: string
  readonly ilink_bot_id?: string
  readonly baseurl?: string
  readonly ilink_user_id?: string
  readonly redirect_host?: string
}

export type MessageItem = {
  readonly type?: number
  readonly text_item?: { readonly text?: string }
  readonly voice_item?: { readonly text?: string }
}

export type WeixinMessage = {
  readonly seq?: number
  /** uint64 on the wire; parsed losslessly as a decimal string. */
  readonly message_id?: string
  readonly from_user_id?: string
  readonly to_user_id?: string
  readonly client_id?: string
  readonly create_time_ms?: number
  readonly message_type?: number
  readonly item_list?: ReadonlyArray<MessageItem>
  readonly context_token?: string
}

export type UpdatesResponse = {
  readonly ret?: number
  readonly errcode?: number
  readonly errmsg?: string
  readonly msgs?: ReadonlyArray<WeixinMessage>
  readonly get_updates_buf?: string
  readonly longpolling_timeout_ms?: number
}

export type SendResponse = { readonly ret?: number; readonly errmsg?: string; readonly message_id?: string }

export type IlinkOptions = {
  readonly baseUrl: string
  readonly token?: string
  /** miao version, reported in base_info.bot_agent. */
  readonly agentVersion: string
  readonly fetch?: typeof fetch
}

export class IlinkError extends Error {
  constructor(
    message: string,
    readonly ret?: number,
  ) {
    super(message)
  }
}

export function createIlinkApi(options: IlinkOptions) {
  const request = options.fetch ?? fetch
  const baseInfo = { channel_version: ProtocolVersion, bot_agent: `miao/${sanitizeVersion(options.agentVersion)}` }

  async function post<A>(endpoint: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    const response = await request(new URL(endpoint, withSlash(options.baseUrl)), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomUin(),
        ...appHeaders(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({ ...body, base_info: baseInfo }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw new IlinkError(`${endpoint} HTTP ${response.status}`)
    return parseLossless<A>(text)
  }

  return {
    /** Long-polls for new messages. A client-side timeout is a normal empty poll. */
    getUpdates: async (cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<UpdatesResponse> => {
      const result = await post<UpdatesResponse>("ilink/bot/getupdates", { get_updates_buf: cursor }, timeoutMs, signal)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }))
      if (result.ok) return result.value
      if (isTimeout(result.error) && !signal?.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor }
      throw result.error
    },
    sendText: (input: { to: string; text: string; contextToken?: string; clientID: string }) =>
      post<SendResponse>(
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: input.to,
            client_id: input.clientID,
            message_type: MessageType.Bot,
            message_state: 2,
            context_token: input.contextToken,
            item_list: [{ type: ItemType.Text, text_item: { text: input.text } }],
          },
        },
        15_000,
      ),
    getConfig: (user: string, contextToken?: string) =>
      post<{ ret?: number; typing_ticket?: string }>(
        "ilink/bot/getconfig",
        { ilink_user_id: user, context_token: contextToken },
        10_000,
      ),
    sendTyping: (user: string, ticket: string, on: boolean) =>
      post<unknown>("ilink/bot/sendtyping", { ilink_user_id: user, typing_ticket: ticket, status: on ? 1 : 2 }, 10_000),
    notifyStart: () => post<unknown>("ilink/bot/msg/notifystart", {}, 10_000),
    notifyStop: () => post<unknown>("ilink/bot/msg/notifystop", {}, 10_000),
  }
}

export type IlinkApi = ReturnType<typeof createIlinkApi>

/** QR login endpoints. They start from the fixed API host and may move to a redirect host. */
export function createLoginApi(input: { fetch?: typeof fetch; baseUrl?: string }) {
  const request = input.fetch ?? fetch
  const base = input.baseUrl ?? DefaultBaseUrl
  return {
    /** Host that QR status polling starts on. */
    base,
    getQrcode: async () => {
      const response = await request(new URL("ilink/bot/get_bot_qrcode?bot_type=3", withSlash(base)), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomUin(),
          ...appHeaders(),
        },
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new IlinkError(`get_bot_qrcode HTTP ${response.status}`)
      return (await response.json()) as { qrcode: string; qrcode_img_content: string }
    },
    /** Network failures read as "wait", matching the official client, so a flaky link only slows login down. */
    getStatus: async (host: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse> => {
      const url = new URL("ilink/bot/get_qrcode_status", withSlash(host))
      url.searchParams.set("qrcode", qrcode)
      if (verifyCode) url.searchParams.set("verify_code", verifyCode)
      return request(url, { headers: appHeaders(), signal: AbortSignal.timeout(35_000) })
        .then((response) =>
          response.ok ? (response.json() as Promise<QrStatusResponse>) : { status: "wait" as const },
        )
        .catch(() => ({ status: "wait" as const }))
    },
  }
}

export type LoginApi = ReturnType<typeof createLoginApi>

const LosslessFields = new Set(["message_id", "msg_id", "svr_id"])

/**
 * JSON.parse that keeps uint64 identifiers exact by quoting them first. Only
 * object keys named in LosslessFields are rewritten; text inside strings is untouched.
 */
export function parseLossless<A>(raw: string): A {
  const output: string[] = []
  const state = { index: 0 }
  while (state.index < raw.length) {
    if (raw[state.index] !== '"') {
      output.push(raw[state.index++])
      continue
    }
    const start = state.index++
    const escaped = { on: false }
    while (state.index < raw.length) {
      const character = raw[state.index++]
      if (escaped.on) {
        escaped.on = false
        continue
      }
      if (character === "\\") {
        escaped.on = true
        continue
      }
      if (character === '"') break
    }
    const token = raw.slice(start, state.index)
    output.push(token)
    const colon = skipSpace(raw, state.index)
    if (raw[colon] !== ":" || !LosslessFields.has(JSON.parse(token))) continue
    const valueStart = skipSpace(raw, colon + 1)
    const match = /^-?\d+/.exec(raw.slice(valueStart))
    if (!match) continue
    output.push(raw.slice(state.index, valueStart), `"${match[0]}"`)
    state.index = valueStart + match[0].length
  }
  return JSON.parse(output.join("")) as A
}

function skipSpace(raw: string, from: number) {
  const offset = raw.slice(from).search(/\S/)
  return offset === -1 ? raw.length : from + offset
}

function appHeaders() {
  return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(clientVersion(ProtocolVersion)) }
}

/** 0x00MMNNPP, as the official client encodes its version. */
export function clientVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** X-WECHAT-UIN: a random uint32 as a decimal string, then base64. */
function randomUin() {
  return Buffer.from(String(crypto.getRandomValues(new Uint32Array(1))[0]), "utf-8").toString("base64")
}

function sanitizeVersion(version: string) {
  const cleaned = version.replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, 32)
  return cleaned || "unknown"
}

function withSlash(url: string) {
  return url.endsWith("/") ? url : `${url}/`
}

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}
