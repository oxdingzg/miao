// QR binding on the QQ open platform ("Agent 接入", 2026-08-26): the phone picks
// or creates a bot and hands its AppID and an encrypted secret to this task.
// Implemented from the published flow (Hermes qqbot onboard, MIT) rather than the
// unlicensed @tencent-connect/qqbot-connector:
//   POST {portal}/lite/create_bind_task {key}      → data.task_id
//   QR   {portal}/qqbot/openclaw/connect.html?task_id=…&source=miao&_wv=2
//   POST {portal}/lite/poll_bind_result {task_id}  → data.status 1 waiting / 2 done / 3 expired
// The secret comes back AES-256-GCM encrypted with our key: base64(IV 12 | ciphertext | tag 16).
import type { LoginContext, LoginStep } from "../../connector"
import { Hosts } from "./api"

export const BindStatus = { Waiting: 1, Done: 2, Expired: 3 } as const

export type BindResult = {
  readonly status: number
  readonly appId?: string
  readonly encryptedSecret?: string
  readonly owner?: string
}

const MaxRefreshes = 3

export async function* bindLogin(context: LoginContext): AsyncGenerator<LoginStep, void, unknown> {
  const portal = (typeof context.options.portal === "string" && context.options.portal) || Hosts.portal
  const interval = typeof context.options.bind_poll_ms === "number" ? context.options.bind_poll_ms : 2000
  for (const attempt of Array.from({ length: MaxRefreshes + 1 }, (_, index) => index)) {
    if (attempt > 0) yield { type: "progress", message: `二维码已过期，正在刷新（${attempt}/${MaxRefreshes}）…` }
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    const task = await createBindTask(portal, key, context.fetch).catch((error: unknown) => error)
    if (task instanceof Error || typeof task !== "string") {
      yield { type: "error", message: `创建绑定任务失败：${task instanceof Error ? task.message : String(task)}` }
      return
    }
    yield {
      type: "qr",
      content: connectUrl(portal, task),
      hint: "用手机 QQ 扫码，新建一个专用机器人（或选一个空闲的）后点「连接到第三方平台」。选中正在为其它服务在线的机器人会断开它原来的连接。",
    }
    while (!context.signal.aborted) {
      await context.sleep(interval)
      if (context.signal.aborted) return
      // A failed poll is usually a flaky network; keep waiting like the official clients do.
      const result = await pollBindResult(portal, task, context.fetch).catch(() => undefined)
      if (!result) continue
      if (result.status === BindStatus.Expired) break
      if (result.status !== BindStatus.Done) continue
      if (!result.appId || !result.encryptedSecret) {
        yield { type: "error", message: "绑定完成但没有返回机器人凭证，请重试" }
        return
      }
      const secret = await decryptSecret(result.encryptedSecret, key).catch(() => undefined)
      if (!secret) {
        yield { type: "error", message: "无法解密机器人密钥，请重试" }
        return
      }
      yield {
        type: "done",
        account: { id: result.appId, label: "QQ 机器人" },
        ...(result.owner ? { owner: result.owner } : {}),
        credentials: { appId: result.appId, secret },
        message: result.owner ? "只接受扫码者本人的消息" : undefined,
      }
      return
    }
    if (context.signal.aborted) return
  }
  yield { type: "error", message: "二维码多次过期，已停止。请稍后重试" }
}

export function connectUrl(portal: string, taskID: string) {
  return `${portal.replace(/\/+$/, "")}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskID)}&source=miao&_wv=2`
}

export async function createBindTask(portal: string, key: string, request: typeof fetch) {
  const body = await post(portal, "/lite/create_bind_task", { key }, request)
  const task = body.data?.task_id
  if (typeof task !== "string" || !task) throw new Error("create_bind_task 没有返回 task_id")
  return task
}

export async function pollBindResult(portal: string, taskID: string, request: typeof fetch): Promise<BindResult> {
  const body = await post(portal, "/lite/poll_bind_result", { task_id: taskID }, request)
  const data = body.data ?? {}
  return {
    status: Number(data.status ?? 0),
    appId: data.bot_appid === undefined ? undefined : String(data.bot_appid),
    encryptedSecret: typeof data.bot_encrypt_secret === "string" ? data.bot_encrypt_secret : undefined,
    owner: typeof data.user_openid === "string" && data.user_openid ? data.user_openid : undefined,
  }
}

async function post(portal: string, endpoint: string, payload: Record<string, unknown>, request: typeof fetch) {
  const response = await request(`${portal.replace(/\/+$/, "")}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`)
  const body = (await response.json()) as { retcode?: number; msg?: string; data?: Record<string, unknown> }
  if (body.retcode !== 0) throw new Error(body.msg || `${endpoint} retcode ${body.retcode}`)
  return body
}

/** base64(IV 12 | ciphertext | tag 16) under AES-256-GCM with the base64 key we registered. */
export async function decryptSecret(encrypted: string, keyBase64: string) {
  const bytes = Buffer.from(encrypted, "base64")
  if (bytes.length <= 28) throw new Error("encrypted secret too short")
  const key = await crypto.subtle.importKey("raw", Buffer.from(keyBase64, "base64"), "AES-GCM", false, ["decrypt"])
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), tagLength: 128 },
    key,
    bytes.subarray(12),
  )
  return new TextDecoder().decode(plain)
}

/** The inverse of decryptSecret; used by the fake QQ service. */
export async function encryptSecret(secret: string, keyBase64: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", Buffer.from(keyBase64, "base64"), "AES-GCM", false, ["encrypt"])
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new TextEncoder().encode(secret),
  )
  return Buffer.concat([Buffer.from(iv), Buffer.from(sealed)]).toString("base64")
}
