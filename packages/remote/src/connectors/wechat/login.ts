// QR login against iLink, mirroring the official plugin's waitForWeixinLogin:
// redirects, verify codes, and at most three QR refreshes.
import { readAccounts, updateAccount, type AccountRecord } from "../../accounts"
import { DefaultBaseUrl, type LoginApi } from "./ilink"

export type Credentials = {
  readonly token: string
  readonly botID: string
  readonly baseUrl: string
  /** The WeChat user who scanned the code; the only person the bot listens to. */
  readonly userID: string
  readonly savedAt: number
  /** Set when iLink reported the token stale (-14); polling stays off until a new login. */
  readonly needsLogin?: { readonly at: number; readonly reason: string }
}

export type LoginResult =
  | { readonly ok: true; readonly credentials: Credentials }
  | { readonly ok: false; readonly message: string; readonly alreadyBound?: boolean }

const MaxRefreshes = 3

export async function login(input: {
  readonly api: LoginApi
  /** Shows a QR code for the given content (a URL the WeChat app understands). */
  readonly show: (content: string) => void
  /** Reads the number shown on the phone when iLink asks for a verify code. */
  readonly ask: (prompt: string) => Promise<string>
  readonly say: (message: string) => void
  readonly timeoutMs?: number
  readonly pollDelayMs?: number
  readonly now?: () => number
  /** Turns a redirect host into a base URL. iLink redirects are always HTTPS. */
  readonly redirect?: (host: string) => string
  /** Stops polling when the user cancels the login. */
  readonly signal?: AbortSignal
}): Promise<LoginResult> {
  const now = input.now ?? Date.now
  const deadline = now() + (input.timeoutMs ?? 480_000)
  const first = await input.api.getQrcode()
  input.show(first.qrcode_img_content)
  const session = {
    qrcode: first.qrcode,
    host: input.api.base,
    refreshes: 1,
    verifyCode: undefined as string | undefined,
    scanned: false,
  }

  const refresh = async () => {
    session.refreshes += 1
    if (session.refreshes > MaxRefreshes) return false
    input.say(`正在刷新二维码（${session.refreshes}/${MaxRefreshes}）…`)
    const next = await input.api.getQrcode()
    session.qrcode = next.qrcode
    session.scanned = false
    input.show(next.qrcode_img_content)
    return true
  }

  while (now() < deadline) {
    if (input.signal?.aborted) return { ok: false, message: "登录已取消" }
    const status = await input.api.getStatus(session.host, session.qrcode, session.verifyCode)
    if (status.status === "need_verifycode") {
      session.verifyCode = (
        await input.ask(session.verifyCode ? "数字不对，请重新输入：" : "输入手机微信上显示的数字：")
      ).trim()
      continue
    }
    if (status.status === "scaned") {
      session.verifyCode = undefined
      if (!session.scanned) input.say("已扫码，请在手机上确认")
      session.scanned = true
    }
    if (status.status === "scaned_but_redirect" && status.redirect_host)
      session.host = input.redirect ? input.redirect(status.redirect_host) : `https://${status.redirect_host}`
    if (status.status === "expired" && !(await refresh()))
      return { ok: false, message: "二维码多次过期，已停止。请稍后重试" }
    if (status.status === "verify_code_blocked") {
      session.verifyCode = undefined
      input.say("验证码输错次数太多")
      if (!(await refresh())) return { ok: false, message: "验证码多次输错，已停止。请稍后重试" }
    }
    if (status.status === "binded_redirect")
      return { ok: false, alreadyBound: true, message: "这个微信已经连接过本机，沿用已保存的凭证" }
    if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id)
        return { ok: false, message: "登录失败：服务器没有返回完整的凭证" }
      return {
        ok: true,
        credentials: {
          token: status.bot_token,
          botID: status.ilink_bot_id,
          baseUrl: status.baseurl || DefaultBaseUrl,
          userID: status.ilink_user_id,
          savedAt: now(),
        },
      }
    }
    await Bun.sleep(input.pollDelayMs ?? 1000)
  }
  return { ok: false, message: "登录超时，请重试" }
}

/** The first saved WeChat account, with its needsLogin mark. */
export async function loadCredentials(file: string): Promise<Credentials | undefined> {
  const record = Object.values((await readAccounts(file)).wechat ?? {})[0]
  const credentials = record ? parseCredentials(record.credentials) : undefined
  if (!record || !credentials) return undefined
  return record.needsLogin ? { ...credentials, needsLogin: record.needsLogin } : credentials
}

export async function saveCredentials(file: string, credentials: Credentials) {
  await updateAccount(file, "wechat", credentials.botID, () => accountRecord(credentials))
}

export function accountRecord(credentials: Credentials): AccountRecord {
  const { needsLogin, ...rest } = credentials
  return {
    label: "微信 ClawBot",
    owner: credentials.userID,
    savedAt: credentials.savedAt,
    ...(needsLogin ? { needsLogin } : {}),
    credentials: rest,
  }
}

export function parseCredentials(value: unknown): Credentials | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Partial<Credentials>
  if (typeof candidate.token !== "string" || typeof candidate.botID !== "string") return undefined
  if (typeof candidate.userID !== "string") return undefined
  return {
    token: candidate.token,
    botID: candidate.botID,
    baseUrl: typeof candidate.baseUrl === "string" && candidate.baseUrl ? candidate.baseUrl : DefaultBaseUrl,
    userID: candidate.userID,
    savedAt: typeof candidate.savedAt === "number" ? candidate.savedAt : 0,
  }
}
