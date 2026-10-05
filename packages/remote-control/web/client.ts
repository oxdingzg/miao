import { Schema } from "effect"
import { RemoteAccess } from "@miao/schema/remote-access"
import { BrowserAccount } from "../src/browser-account"
import { BrowserIdentity } from "../src/browser-identity"
import { BrowserChannel } from "../src/browser-channel"
import { BrowserCheckpoint } from "../src/browser-checkpoint"
import { RemoteRPC } from "../src/remote-rpc"

const get = <T extends HTMLElement>(id: string, kind: { new (): T }): T => {
  const value = document.getElementById(id)
  if (!(value instanceof kind)) throw new Error("Interface is unavailable")
  return value
}
const notice = get("notice", HTMLDivElement)
const draft = get("draft", HTMLTextAreaElement)
const send = get("send", HTMLButtonElement)
const timeline = get("timeline", HTMLDivElement)
const title = get("session-title", HTMLHeadingElement)
const badge = get("connection", HTMLSpanElement)
const login = get("login", HTMLElement)
const directory = get("directory", HTMLElement)
const hosts = get("hosts", HTMLDivElement)
const sessions = get("sessions", HTMLDivElement)
let generation = 0
let rpc: ReturnType<typeof RemoteRPC.make> | undefined
let scope: BrowserCheckpoint.Scope | undefined
const draftRevisions = new Map<BrowserCheckpoint.Scope, number>()
let draftWrites: Promise<unknown> = Promise.resolve()
let selected: Host | undefined
let selectedSession: string | undefined
let discovered: Host[] = []
let cache: Awaited<ReturnType<typeof BrowserCheckpoint.open>>
let identity: Awaited<ReturnType<typeof BrowserIdentity.load>>
let grant: RemoteAccess.Grant | undefined
const account = BrowserAccount.make({
  onInvalidated: () => {
    disconnect()
    login.hidden = false
    directory.hidden = true
    timeline.replaceChildren()
    sessions.replaceChildren()
    draft.value = ""
    selected = undefined
    selectedSession = undefined
    title.textContent = "选择一个会话"
  },
})
type Host = {
  hostID: string
  name: string
  publicKey: string
  online: boolean
  runtimeID?: string
  revokedAt: number | null
}
type Message = { id: string; role: "user" | "assistant" | "activity"; text: string }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
function disconnect() {
  generation++
  rpc?.close()
  rpc = undefined
  scope = undefined
  send.disabled = true
  draft.disabled = true
  badge.textContent = "未连接"
}
function report(message: string) {
  notice.textContent = message
}
function run(action: () => Promise<void>) {
  void action().catch(() => report("操作未能确认。请检查连接后重试；已发送的输入不会自动重发。"))
}
function stamp(hostID: string) {
  const session = account.session()
  if (!session) throw new Error("Account login required")
  return JSON.stringify(["miao.remote-control.grant", location.origin, session.accountID, identity.publicKey, hostID])
}
function trusted(host: Host): RemoteAccess.Grant | undefined {
  const raw = localStorage.getItem(stamp(host.hostID))
  if (!raw) return
  const value: unknown = JSON.parse(raw)
  if (!record(value) || value.publicKey !== host.publicKey)
    throw new Error("Host identity changed; explicit re-pairing required")
  return Schema.decodeUnknownSync(RemoteAccess.Grant)(value.grant)
}
async function refresh() {
  const current = generation
  const value = await account.directory()
  if (current !== generation) return
  if (!record(value) || !Array.isArray(value.data) || value.data.length > 64) throw new Error("Invalid host directory")
  hosts.replaceChildren()
  discovered = []
  for (const item of value.data) {
    if (
      !record(item) ||
      typeof item.hostID !== "string" ||
      typeof item.name !== "string" ||
      typeof item.publicKey !== "string" ||
      typeof item.online !== "boolean" ||
      (item.runtimeID !== undefined && typeof item.runtimeID !== "string") ||
      (item.revokedAt !== null && typeof item.revokedAt !== "number")
    )
      throw new Error("Invalid host directory entry")
    const host: Host = {
      hostID: item.hostID,
      name: item.name,
      publicKey: item.publicKey,
      online: item.online,
      runtimeID: item.runtimeID,
      revokedAt: item.revokedAt,
    }
    discovered.push(host)
    const button = document.createElement("button")
    button.className = "item"
    button.textContent = host.name
    const detail = document.createElement("small")
    detail.textContent = host.online ? "在线 · 可连接" : "离线"
    button.append(detail)
    button.disabled = !host.online || host.revokedAt !== null
    button.onclick = () => run(() => connect(host))
    hosts.append(button)
  }
  if (!hosts.childNodes.length) hosts.textContent = "还没有电脑。在电脑的 /remote-control 中连接此中继。"
}
async function connect(host: Host) {
  disconnect()
  selected = host
  selectedSession = undefined
  const current = generation
  const approved = trusted(host)
  if (!approved) {
    report("请先使用电脑上的配对邀请，并在电脑确认授权。")
    return
  }
  if (approved.publicKey !== identity.publicKey || approved.expiresAt <= Date.now() || approved.revokedAt !== null)
    throw new Error("Grant expired")
  if (!host.runtimeID) throw new Error("Runtime offline")
  const target = { hostID: host.hostID, runtimeID: host.runtimeID }
  const transport = await BrowserChannel.connect({
    hubURL: location.origin,
    target,
    identity,
    trustedHostKey: host.publicKey,
    ticket: await account.ticket(host.hostID, host.runtimeID),
    allowLoopbackHTTP: loopback(),
  })
  if (current !== generation) {
    transport.close()
    return
  }
  grant = approved
  rpc = RemoteRPC.make({ transport, target, grant: approved, identityPublicKey: identity.publicKey })
  const connected = rpc
  void connected.finished.then(() => {
    if (rpc === connected) disconnect()
  })
  badge.textContent = "已加密连接"
  report("")
  const value = await rpc.request("session.list", { payload: { limit: 100 } })
  if (current !== generation) return
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Invalid sessions")
  sessions.replaceChildren()
  for (const session of value.data) {
    if (!record(session) || typeof session.id !== "string" || typeof session.title !== "string")
      throw new Error("Invalid session")
    const id = session.id
    const label = session.title
    const button = document.createElement("button")
    button.className = "item"
    button.textContent = label
    button.onclick = () => run(() => openSession(id, label))
    sessions.append(button)
  }
  if (!sessions.childNodes.length) sessions.textContent = "没有已授权的会话。请在电脑调整设备授权。"
}
async function pair() {
  const input = get("invitation", HTMLTextAreaElement)
  const raw = input.value.trim()
  input.value = ""
  if (raw.length > 8192) throw new Error("Invitation too large")
  const encoded = raw.startsWith("{") ? undefined : new URL(raw)
  if (
    encoded &&
    (encoded.protocol !== "miao:" ||
      encoded.hostname !== "pair" ||
      encoded.pathname ||
      encoded.search ||
      encoded.username ||
      encoded.password ||
      !/^[A-Za-z0-9_-]+$/.test(encoded.hash.slice(1)))
  )
    throw new Error("Invalid invitation link")
  const json = encoded
    ? new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(encoded.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/")), (character) =>
          character.charCodeAt(0),
        ),
      )
    : raw
  const invitation = Schema.decodeUnknownSync(RemoteAccess.Invitation)(JSON.parse(json))
  if (new URL(invitation.hubURL).origin !== location.origin || invitation.expiresAt <= Date.now())
    throw new Error("Invalid invitation")
  disconnect()
  const current = generation
  report("等待电脑确认设备授权…")
  const transport = await BrowserChannel.connect({
    hubURL: location.origin,
    ticket: await account.ticket(invitation.hostID, invitation.runtimeID),
    target: { hostID: invitation.hostID, runtimeID: invitation.runtimeID },
    identity,
    trustedHostKey: invitation.hostPublicKey,
    invitation,
    label: "Web browser",
    allowLoopbackHTTP: loopback(),
  })
  try {
    if (current !== generation) return
    for (;;) {
      const value = await transport.receive(Math.max(1, Math.min(120000, invitation.expiresAt - Date.now())))
      if (current !== generation) return
      if (!record(value) || value.version !== 1 || value.type !== "pairing") throw new Error("Invalid pairing response")
      if (value.status === "pending" && value.pairingID === invitation.pairingID) continue
      if (value.status !== "approved") throw new Error("Pairing not approved")
      const approved = Schema.decodeUnknownSync(RemoteAccess.Grant)(value.grant)
      if (approved.publicKey !== identity.publicKey || approved.revokedAt !== null || approved.expiresAt <= Date.now())
        throw new Error("Invalid grant")
      localStorage.setItem(
        stamp(invitation.hostID),
        JSON.stringify({ publicKey: invitation.hostPublicKey, grant: approved }),
      )
      report("设备已授权。选择电脑继续。")
      await refresh()
      return
    }
  } finally {
    transport.close()
  }
}
function paint(messages: Message[]) {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
  timeline.replaceChildren()
  for (const message of messages) {
    const item = document.createElement("article")
    item.className = "message " + message.role
    const label = document.createElement("small")
    label.textContent = message.role === "user" ? "你" : message.role === "assistant" ? "MIAO" : "任务进展"
    item.append(label, document.createTextNode(message.text))
    timeline.append(item)
  }
  if (atBottom) timeline.scrollTop = timeline.scrollHeight
}
function saveDraft() {
  const captured = scope
  const text = draft.value
  if (!captured) return Promise.resolve()
  const queued = draftWrites.then(async () => {
    const stored = await cache.saveDraft(captured, text, draftRevisions.get(captured) ?? 0)
    draftRevisions.set(captured, stored.revision)
    return stored
  })
  draftWrites = queued.catch(() => {
    report("草稿保存失败，请保留输入后重新连接。")
    send.disabled = true
  })
  return queued
}
async function openSession(sessionID: string, label: string) {
  const connection = rpc
  const host = selected
  const approved = grant
  const session = account.session()
  if (!connection || !host?.runtimeID || !approved || !session) throw new Error("Disconnected")
  await draftWrites
  const current = ++generation
  selectedSession = sessionID
  const partition: BrowserCheckpoint.Scope = {
    hubURL: location.origin,
    accountID: session.accountID,
    devicePublicKey: identity.publicKey,
    hostID: host.hostID,
    runtimeID: host.runtimeID,
    grantID: approved.id,
    grantVersion: approved.version,
    sessionID,
  }
  scope = partition
  draft.disabled = true
  send.disabled = true
  title.textContent = label
  const saved = await cache.read(partition)
  const savedDraft = await cache.readDraft(partition)
  if (current !== generation) return
  let revision = saved?.revision ?? 0
  let cursor = saved?.cursor ?? 0
  let messages: Message[] = saved ? decodeMessages(JSON.parse(saved.state)) : []
  draft.value = savedDraft?.text ?? ""
  draftRevisions.set(partition, savedDraft?.revision ?? 0)
  draft.disabled = !approved.permissions.includes("prompt")
  send.disabled = draft.disabled
  paint(messages)
  // Only query uncertain admissions; reconnect never dispatches a stored operation.
  for (const operation of await cache.operations(partition)) {
    if (!["awaitingConfirmation", "outcomeUnknown", "accepted"].includes(operation.status)) continue
    const receipt = await connection.request("operation.get", { sessionID, payload: { operationID: operation.id } })
    if (current !== generation) return
    if (!record(receipt)) throw new Error("Invalid receipt")
    if (receipt.status === "accepted" || receipt.status === "completed") {
      const confirmed = await cache.transitionOperation(
        partition,
        operation.id,
        operation.revision,
        receipt.status,
        JSON.stringify(receipt),
      )
      if (confirmed.status === "accepted")
        await cache.transitionOperation(
          partition,
          operation.id,
          confirmed.revision,
          "completed",
          JSON.stringify(receipt),
        )
    } else report("有一条输入尚未确认。请在电脑查看，避免重复发送。")
  }
  while (current === generation && !connection.stopped()) {
    const page = await connection.request("session.events", {
      sessionID,
      payload: { after: cursor, limit: 100, waitMs: 1000 },
    })
    if (current !== generation) return
    if (
      !record(page) ||
      !Array.isArray(page.data) ||
      !Number.isSafeInteger(page.cursor) ||
      typeof page.cursor !== "number" ||
      page.cursor < cursor
    )
      throw new Error("Invalid history page")
    if (!page.data.length) continue
    let next = cursor
    const projected = [...messages]
    for (const event of page.data) {
      if (
        !record(event) ||
        !record(event.durable) ||
        typeof event.durable.seq !== "number" ||
        !Number.isSafeInteger(event.durable.seq) ||
        event.durable.seq <= next ||
        !record(event.data) ||
        event.data.sessionID !== sessionID
      )
        throw new Error("Invalid session event")
      next = event.durable.seq
      const text =
        event.type === "session.next.prompted" && record(event.data.prompt) ? event.data.prompt.text : event.data.text
      if (
        typeof text === "string" &&
        ["session.next.prompted", "session.next.text.ended", "session.next.reasoning.ended"].includes(
          String(event.type),
        )
      ) {
        projected.push({ id: String(next), role: event.type === "session.next.prompted" ? "user" : "assistant", text })
      }
    }
    if (next !== page.cursor) throw new Error("Cursor mismatch")
    const bounded = projected.slice(-500)
    while (bounded.length > 1 && new TextEncoder().encode(JSON.stringify(bounded)).length > 7 * 1024 * 1024)
      bounded.shift()
    const committed = await cache.commit(partition, { cursor: next, state: JSON.stringify(bounded) }, revision)
    if (current !== generation) return
    revision = committed.revision
    cursor = next
    messages = bounded
    paint(messages)
  }
}
function decodeMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Invalid saved messages")
  return value.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      item.text.length > 8 * 1024 * 1024 ||
      !["user", "assistant", "activity"].includes(String(item.role))
    )
      throw new Error("Invalid saved message")
    return { id: item.id, text: item.text, role: item.role as Message["role"] }
  })
}
async function submit() {
  const connection = rpc
  const partition = scope
  const text = draft.value
  const current = generation
  if (!connection || !partition || !text.trim() || send.disabled) return
  send.disabled = true
  const submittedDraft = await saveDraft()
  const prepared = await cache.prepareOperation(partition, {
    id: crypto.randomUUID(),
    method: "session.prompt",
    payload: JSON.stringify({ text, delivery: get("delivery", HTMLSelectElement).value }),
  })
  const claimed = await cache.transitionOperation(partition, prepared.id, prepared.revision, "awaitingConfirmation")
  try {
    const receipt = await connection.request("session.prompt", {
      sessionID: partition.sessionID,
      operationID: prepared.id,
      payload: JSON.parse(prepared.payload),
    })
    if (!record(receipt) || receipt.status !== "accepted" || receipt.sessionID !== partition.sessionID)
      throw new Error("Invalid admission receipt")
    const confirmed = await cache.transitionOperation(
      partition,
      prepared.id,
      claimed.revision,
      "accepted",
      JSON.stringify(receipt),
    )
    // The admission operation is confirmed; model execution has its own lifecycle.
    await cache.transitionOperation(partition, prepared.id, confirmed.revision, "completed", JSON.stringify(receipt))
    if (current !== generation) return
    // Preserve anything edited while the request was in flight.
    await draftWrites
    if (current !== generation) return
    if (draft.value === text && submittedDraft && draftRevisions.get(partition) === submittedDraft.revision) {
      draft.value = ""
      await saveDraft()
    }
    report("输入已接收。")
  } catch {
    await cache.transitionOperation(partition, prepared.id, claimed.revision, "outcomeUnknown")
    report("输入结果尚未确认，已保留记录。重新连接时只查询状态，不会自动重发。")
  } finally {
    if (current === generation) send.disabled = !grant?.permissions.includes("prompt")
  }
}
function loopback() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
}
get("login-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(async () => {
    const password = get("password", HTMLInputElement)
    const secret = password.value
    password.value = ""
    await account.signIn(get("email", HTMLInputElement).value, secret)
    login.hidden = true
    directory.hidden = false
    await refresh()
  })
}
get("pair-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(pair)
}
get("composer", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(submit)
}
draft.oninput = () => {
  void saveDraft().catch(() => undefined)
}
get("refresh", HTMLButtonElement).onclick = () => run(refresh)
get("logout", HTMLButtonElement).onclick = () =>
  run(async () => {
    disconnect()
    draft.value = ""
    timeline.replaceChildren()
    sessions.replaceChildren()
    hosts.replaceChildren()
    login.hidden = false
    directory.hidden = true
    await account.signOut()
    report("已退出。")
  })
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    disconnect()
    return
  }
  const hostID = selected?.hostID
  const sessionID = selectedSession
  const label = title.textContent ?? "会话"
  if (!hostID) return
  run(async () => {
    if (!(await account.restore())) return
    await refresh()
    const host = discovered.find((host) => host.hostID === hostID && host.online && host.revokedAt === null)
    if (!host) {
      report("电脑暂时离线。可在恢复连接后继续。")
      return
    }
    await connect(host)
    if (sessionID) await openSession(sessionID, label)
  })
})
window.addEventListener("pagehide", disconnect)
run(async () => {
  if (!window.isSecureContext || !navigator.locks) throw new Error("HTTPS required")
  identity = await BrowserIdentity.load()
  cache = await BrowserCheckpoint.open()
  const session = await account.restore()
  login.hidden = !!session
  directory.hidden = !session
  if (session) await refresh()
  if (account.revocationPending()) report("上次退出尚未确认。请重新登录以完成退出重试。")
})
