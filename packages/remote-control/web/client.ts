import { PairingLink } from "../src/pairing-link"
import { Schema } from "effect"
import { RemoteAccess } from "@miao/schema/remote-access"
import { BrowserAccount } from "../src/browser-account"
import { BrowserEnrollment } from "../src/browser-enrollment"
import { DeviceEnrollment } from "../src/device-enrollment"
import { DeviceRoster } from "../src/device-roster"
import { BrowserIdentity } from "../src/browser-identity"
import { BrowserChannel } from "../src/browser-channel"
import { BrowserCheckpoint } from "../src/browser-checkpoint"
import { RemoteRPC } from "../src/remote-rpc"
import { Permission } from "@miao/schema/permission"
import { Question } from "@miao/schema/question"
import { Revert } from "@miao/schema/revert"
import type { ControlAgent } from "../src/agent"

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
const selectionButton = get("selection", HTMLButtonElement)
const selectionDialog = get("selection-dialog", HTMLDialogElement)
const agentChoice = get("agent-choice", HTMLSelectElement)
const modelChoice = get("model-choice", HTMLSelectElement)
const variantChoice = get("variant-choice", HTMLSelectElement)
let selectionScope: BrowserCheckpoint.Scope | undefined
let selectionModels: { id: string; providerID: string; name: string; variants: { id: string }[] }[] = []
const rename = get("rename", HTMLButtonElement)
const interrupt = get("interrupt", HTMLButtonElement)
const pending = get("pending", HTMLElement)
const renameDialog = get("rename-dialog", HTMLDialogElement)
const diffButton = get("diff", HTMLButtonElement)
const diffDialog = get("diff-dialog", HTMLDialogElement)
const diffContent = get("diff-content", HTMLDivElement)
let renameScope: BrowserCheckpoint.Scope | undefined
let observedExecutionID: string | undefined
let pendingSignature = ""
const pendingNodes = new Map<string, { node: HTMLElement; fingerprint: string }>()
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
let enrollmentEpoch = 0
let enrollmentFlow: ReturnType<typeof DeviceEnrollment.make> | undefined
let enrollmentAccount: string | undefined
const account = BrowserAccount.make({
  onInvalidated: () => {
    enrollmentEpoch++
    enrollmentFlow?.cancel()
    enrollmentFlow = undefined
    enrollmentAccount = undefined
    for (const id of ["enrollment-request", "enrollment-incoming", "enrollment-response", "enrollment-approved"])
      get(id, HTMLTextAreaElement).value = ""
    for (const id of ["enrollment-signer", "enrollment-pin"]) get(id, HTMLInputElement).value = ""
    for (const id of ["root-consent", "enrollment-oob"]) get(id, HTMLInputElement).checked = false
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
  selectionButton.disabled = true
  selectionDialog.close()
  selectionScope = undefined
  selectionModels = []
  rename.disabled = true
  interrupt.disabled = true
  observedExecutionID = undefined
  pending.replaceChildren()
  pendingSignature = ""
  pendingNodes.clear()
  renameDialog.close()
  diffButton.disabled = true
  diffDialog.close()
  diffContent.replaceChildren()
}
function report(message: string) {
  notice.textContent = message
}
function run(action: () => Promise<void>) {
  void action().catch((error: unknown) => {
    if (error instanceof RemoteRPC.RequestError && error.code === "disconnected") return
    console.warn("Remote action failed", error instanceof RemoteRPC.RequestError ? error.code : "invalid_response")
    report("操作未能确认。请检查连接后重试；已发送的输入不会自动重发。")
  })
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
      (item.runtimeID != null && typeof item.runtimeID !== "string") ||
      (item.revokedAt !== null && typeof item.revokedAt !== "number")
    )
      throw new Error("Invalid host directory entry")
    const host: Host = {
      hostID: item.hostID,
      name: item.name,
      publicKey: item.publicKey,
      online: item.online,
      runtimeID: item.runtimeID ?? undefined,
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
  sessions.replaceChildren()
  selected = host
  selectedSession = undefined
  const current = generation
  let approved = trusted(host)
  const local = enrollmentStore()
  let enrolled = await local.store.read()
  let roster: DeviceRoster.Signed | undefined
  let hostKey = host.publicKey
  if (enrolled?.hosts.some((pin) => pin.hostID === host.hostID)) {
    const snapshot = await BrowserEnrollment.snapshot(await account.roster(), local.accountID)
    if (!snapshot) throw new Error("Account roster unavailable")
    enrolled = await local.store.refresh(snapshot)
    const pin = enrolled.hosts.find((pin) => pin.hostID === host.hostID)!
    if (pin.publicKey !== host.publicKey) throw new Error("Host identity changed")
    hostKey = pin.publicKey
    roster = snapshot
    approved = undefined
  }
  if (!approved && !roster) {
    report("请先使用电脑上的配对邀请，并在电脑确认授权。")
    return
  }
  if (
    approved &&
    (approved.publicKey !== identity.publicKey || approved.expiresAt <= Date.now() || approved.revokedAt !== null)
  )
    throw new Error("Grant expired")
  if (!host.runtimeID) throw new Error("Runtime offline")
  const target = { hostID: host.hostID, runtimeID: host.runtimeID }
  const transport = await BrowserChannel.connect({
    hubURL: location.origin,
    target,
    identity,
    trustedHostKey: hostKey,
    roster: roster ? { accountID: local.accountID, snapshot: roster } : undefined,
    ticket: await account.ticket(host.hostID, host.runtimeID),
    allowLoopbackHTTP: loopback(),
  })
  if (current !== generation) {
    transport.close()
    return
  }
  approved ??= transport.grant
  if (!approved) {
    transport.close()
    throw new Error("Account grant missing")
  }
  localStorage.setItem(stamp(host.hostID), JSON.stringify({ publicKey: hostKey, grant: approved }))
  grant = approved
  rpc = RemoteRPC.make({ transport, target, grant: approved, identityPublicKey: identity.publicKey })
  const connected = rpc
  void connected.finished.then(() => {
    if (rpc === connected) disconnect()
  })
  badge.textContent = "已加密连接"
  report("")
  sessions.replaceChildren()
  if (approved.sessionIDs.length) await sessionGroup(connected, "已授权的会话")
  if (connected !== rpc) return
  if (approved.projectIDs.length) {
    const projects = await connected.request("project.list")
    if (connected !== rpc) return
    if (!record(projects) || !Array.isArray(projects.data) || projects.data.length > 128)
      throw new Error("Invalid projects")
    for (const project of projects.data) {
      if (!record(project) || typeof project.id !== "string" || !approved.projectIDs.includes(project.id))
        throw new Error("Invalid project")
      await sessionGroup(
        connected,
        typeof project.name === "string" && project.name ? project.name : "项目会话",
        project.id,
        project.directories,
      )
      if (connected !== rpc) return
    }
  }
  if (!sessions.childNodes.length) sessions.textContent = "没有已授权的会话。请在电脑调整设备授权。"
}
async function sessionGroup(
  connection: ReturnType<typeof RemoteRPC.make>,
  label: string,
  projectID?: string,
  directories?: unknown,
) {
  const group = document.createElement("section")
  const heading = document.createElement("h3")
  heading.textContent = label
  const entries = document.createElement("div")
  const previous = document.createElement("button")
  previous.textContent = "上一页"
  previous.className = "quiet"
  const next = document.createElement("button")
  next.textContent = "下一页"
  next.className = "quiet"
  const cursors: (string | undefined)[] = [undefined]
  let page = 0
  let nextCursor: string | null = null
  let busy = false
  const load = async (cursor: string | undefined, index: number) => {
    if (busy || connection !== rpc) return
    busy = true
    previous.disabled = next.disabled = true
    try {
      const value = await connection.request("session.list", {
        projectID,
        payload: { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
      })
      if (connection !== rpc) return
      if (
        !record(value) ||
        !Array.isArray(value.data) ||
        value.data.length > 100 ||
        !record(value.cursor) ||
        (value.cursor.next !== null &&
          (typeof value.cursor.next !== "string" ||
            !value.cursor.next ||
            value.cursor.next.length > 2048 ||
            value.cursor.next === cursor))
      )
        throw new Error("Invalid sessions page")
      const buttons = value.data.map((session) => {
        if (
          !record(session) ||
          typeof session.id !== "string" ||
          typeof session.title !== "string" ||
          (projectID && session.projectID !== projectID)
        )
          throw new Error("Invalid session")
        const id = session.id
        const button = document.createElement("button")
        button.className = "item"
        button.textContent = session.title
        button.dataset.sessionId = id
        button.onclick = () =>
          run(async () => {
            if (connection === rpc) await openSession(id, button.textContent ?? "会话")
          })
        return button
      })
      entries.replaceChildren(...buttons)
      if (!buttons.length) entries.textContent = "此页没有会话。"
      page = index
      nextCursor = value.cursor.next
    } finally {
      busy = false
      previous.disabled = page === 0
      next.disabled = nextCursor === null
    }
  }
  previous.onclick = () => run(() => load(cursors[page - 1], page - 1))
  next.onclick = () =>
    run(async () => {
      if (!nextCursor) return
      cursors.splice(page + 1, cursors.length, nextCursor)
      await load(nextCursor, page + 1)
    })
  group.append(heading, entries, previous, next)
  if (projectID && grant?.permissions.includes("session.create")) {
    if (!Array.isArray(directories) || directories.length > 256) throw new Error("Invalid project directories")
    const directory = document.createElement("select")
    directory.setAttribute("aria-label", label + " 会话目录")
    for (const entry of directories) {
      if (
        !record(entry) ||
        typeof entry.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.id) ||
        typeof entry.name !== "string"
      )
        throw new Error("Invalid project directory")
      const option = document.createElement("option")
      option.value = entry.id
      option.textContent = entry.name
      directory.append(option)
    }
    const create = document.createElement("button")
    create.textContent = "新建会话"
    create.className = "quiet"
    create.disabled = !directory.options.length
    const partitionFor = (directoryID: string): BrowserCheckpoint.Scope => {
      const accountID = account.session()?.accountID
      const host = selected
      const approved = grant
      if (!accountID || !host?.runtimeID || !approved || connection !== rpc) throw new Error("Connection changed")
      return {
        hubURL: location.origin,
        accountID,
        devicePublicKey: identity.publicKey,
        hostID: host.hostID,
        runtimeID: host.runtimeID,
        grantID: approved.id,
        grantVersion: approved.version,
        sessionID: "create_" + directoryID,
      }
    }
    const verify = async () => {
      create.disabled = true
      if (!directory.value || connection !== rpc) return false
      const verifiedDirectory = directory.value
      const partition = partitionFor(verifiedDirectory)
      for (const operation of await cache.operations(partition)) {
        if (operation.method !== "session.create") throw new Error("Invalid creation record")
        // Another tab may still claim a prepared operation. Reading its ledger must not cancel it.
        if (operation.status === "prepared") continue
        if (!["awaitingConfirmation", "outcomeUnknown"].includes(operation.status)) continue
        const receipt = await connection.request("operation.get", { projectID, payload: { operationID: operation.id } })
        if (connection !== rpc || directory.value !== verifiedDirectory) return false
        if (!record(receipt) || !["completed", "rejected"].includes(String(receipt.status))) {
          report("上次创建结果尚未确认。请在电脑核对，避免重复创建。")
          return false
        }
        await cache.transitionOperation(
          partition,
          operation.id,
          operation.revision,
          receipt.status === "completed" ? "completed" : "rejected",
          JSON.stringify(receipt),
        )
      }
      if (connection !== rpc || directory.value !== verifiedDirectory) return false
      create.disabled = false
      return true
    }
    directory.onchange = () =>
      run(async () => {
        await verify()
      })
    create.onclick = () =>
      run(async () => {
        const accountID = account.session()?.accountID
        const host = selected
        const approved = grant
        if (create.disabled || connection !== rpc || !accountID || !host?.runtimeID || !approved) return
        create.disabled = true
        const directoryID = directory.value
        const partition = partitionFor(directoryID)
        const prepared = await cache.prepareOperation(partition, {
          id: crypto.randomUUID(),
          method: "session.create",
          payload: JSON.stringify({ projectID, directoryID }),
        })
        const claimed = await cache.transitionOperation(
          partition,
          prepared.id,
          prepared.revision,
          "awaitingConfirmation",
        )
        if (connection !== rpc) {
          await cache.transitionOperation(partition, prepared.id, claimed.revision, "rejected")
          return
        }
        const result = await connection
          .request("session.create", { projectID, operationID: prepared.id, payload: { directoryID } })
          .catch((error: unknown) => error)
        if (
          !record(result) ||
          result.status !== "completed" ||
          !record(result.session) ||
          typeof result.session.id !== "string" ||
          typeof result.session.title !== "string" ||
          result.session.projectID !== projectID
        ) {
          await cache.transitionOperation(partition, prepared.id, claimed.revision, "outcomeUnknown")
          if (connection === rpc) report("创建结果尚未确认。请在电脑核对，避免重复创建。")
          return
        }
        await cache.transitionOperation(partition, prepared.id, claimed.revision, "completed", JSON.stringify(result))
        if (connection !== rpc) return
        create.disabled = false
        await load(undefined, 0)
        await openSession(result.session.id, result.session.title)
      })
    group.append(directory, create)
    await verify()
  }
  sessions.append(group)
  await load(undefined, 0)
}
function enrollmentStore() {
  const session = account.session()
  if (!session) throw new Error("Account login required")
  const current = enrollmentEpoch
  return {
    accountID: session.accountID,
    store: BrowserEnrollment.open(
      { hubURL: location.origin, accountID: session.accountID, deviceKey: identity.publicKey },
      () => current === enrollmentEpoch && account.session()?.accountID === session.accountID,
    ),
  }
}
function enrollment() {
  const session = account.session()
  if (!session) throw new Error("Account login required")
  if (!enrollmentFlow || enrollmentAccount !== session.accountID) {
    enrollmentFlow?.cancel()
    enrollmentFlow = DeviceEnrollment.make(identity, { hubURL: location.origin, accountID: session.accountID })
    enrollmentAccount = session.accountID
  }
  return enrollmentFlow
}
get("enrollment-root", HTMLButtonElement).onclick = () =>
  run(async () => {
    if (!get("root-consent", HTMLInputElement).checked) throw new Error("Signer consent required")
    const local = enrollmentStore()
    if (await local.store.read()) {
      report("本设备已有账号名单信任。")
      return
    }
    const existing = await BrowserEnrollment.snapshot(await account.roster(), local.accountID)
    const pins = discovered
      .flatMap((host) => {
        const approved = trusted(host)
        return approved &&
          approved.publicKey === identity.publicKey &&
          approved.expiresAt > Date.now() &&
          approved.revokedAt === null
          ? [{ hostID: host.hostID, publicKey: host.publicKey }]
          : []
      })
      .sort((a, b) => (a.hostID < b.hostID ? -1 : a.hostID > b.hostID ? 1 : 0))
    if (!pins.length) throw new Error("Independent pairing required")
    const roster =
      existing ??
      (await DeviceRoster.sign(identity, {
        version: 1,
        accountID: local.accountID,
        sequence: 1,
        issuedAt: Date.now(),
        devices: [{ publicKey: identity.publicKey, label: "账号签名设备", signer: true, addedAt: Date.now() }],
      }))
    const verified = await DeviceRoster.accept(roster, {
      accountID: local.accountID,
      acceptedSequence: 0,
      signerKeys: [identity.publicKey],
    })
    if (!verified.roster.devices.some((device) => device.publicKey === identity.publicKey && device.signer))
      throw new Error("This device is not a roster signer")
    const published =
      existing ??
      (await BrowserEnrollment.snapshot(
        await account.putRoster(await BrowserEnrollment.update(roster)),
        local.accountID,
      ))
    if (
      !published ||
      (await DeviceRoster.fingerprint(published.roster)) !== (await DeviceRoster.fingerprint(roster.roster))
    )
      throw new Error("Roster publication not confirmed")
    await local.store.put({
      version: 1,
      hubURL: location.origin,
      accountID: local.accountID,
      deviceKey: identity.publicKey,
      roster,
      digest: await DeviceRoster.fingerprint(roster.roster),
      hosts: pins,
    })
    get("enrollment-signer", HTMLInputElement).value = identity.publicKey
    report("签名设备已初始化。请确认电脑已明确选择信任此设备。")
  })
get("enrollment-request-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(async () => {
    const request = await enrollment().begin(get("enrollment-label", HTMLInputElement).value)
    get("enrollment-request", HTMLTextAreaElement).value = JSON.stringify(request)
    report("把注册码直接发送给已信任的签名设备，十分钟内完成批准。")
  })
}
get("enrollment-approve-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(async () => {
    const raw = get("enrollment-incoming", HTMLTextAreaElement).value
    if (raw.length > 131072) throw new Error("Enrollment input too large")
    const request = Schema.decodeUnknownSync(DeviceEnrollment.Request, { onExcessProperty: "error" })(JSON.parse(raw))
    if (
      !confirm(
        `批准设备「${request.payload.label}」？\n设备公钥：${request.payload.publicKey}\n新设备将使用电脑已确认的账号授权范围。`,
      )
    )
      return
    const local = enrollmentStore()
    const snapshot = await BrowserEnrollment.snapshot(await account.roster(), local.accountID)
    if (!snapshot) throw new Error("Accepted roster required")
    const current = await local.store.refresh(snapshot)
    const approved = await DeviceEnrollment.approve(identity, request, {
      hubURL: location.origin,
      accountID: local.accountID,
      current: current.roster,
      authority: BrowserEnrollment.authority(current),
      hosts: current.hosts,
    })
    const published = await BrowserEnrollment.snapshot(
      await account.putRoster(await BrowserEnrollment.update(approved.roster)),
      local.accountID,
    )
    if (
      !published ||
      (await DeviceRoster.fingerprint(published.roster)) !== (await DeviceRoster.fingerprint(approved.roster.roster))
    )
      throw new Error("Roster publication not confirmed")
    await local.store.refresh(published)
    get("enrollment-response", HTMLTextAreaElement).value = JSON.stringify(approved)
    get("enrollment-signer", HTMLInputElement).value = identity.publicKey
    report("已批准。将结果及签名公钥直接返回新设备。")
  })
}
get("enrollment-receive-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(async () => {
    if (!get("enrollment-oob", HTMLInputElement).checked) throw new Error("Independent signer pin required")
    const raw = get("enrollment-approved", HTMLTextAreaElement).value
    if (raw.length > 131072) throw new Error("Enrollment input too large")
    const local = enrollmentStore()
    const accepted = await enrollment().receive(JSON.parse(raw), get("enrollment-pin", HTMLInputElement).value.trim())
    await local.store.put({
      version: 1,
      hubURL: location.origin,
      accountID: local.accountID,
      deviceKey: identity.publicKey,
      roster: { version: 1, roster: accepted.roster.roster, signature: accepted.roster.signature },
      digest: accepted.roster.digest,
      hosts: accepted.hosts,
    })
    get("enrollment-approved", HTMLTextAreaElement).value = ""
    get("enrollment-request", HTMLTextAreaElement).value = ""
    await refresh()
    report("设备注册完成。选择在线电脑查看已开启远程控制的会话。")
  })
}

async function pair() {
  const input = get("invitation", HTMLTextAreaElement)
  const raw = input.value.trim()
  input.value = ""
  const invitation = PairingLink.parse(raw, location.origin, loopback())
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
function decodeLive(value: unknown): Message[] {
  if (value === undefined) return []
  if (
    !record(value) ||
    typeof value.epoch !== "string" ||
    value.epoch.length > 64 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 0 ||
    (value.messageID !== null && (typeof value.messageID !== "string" || value.messageID.length > 256)) ||
    !Array.isArray(value.parts) ||
    value.parts.length > 32 ||
    (value.messageID === null && value.parts.length)
  )
    throw new Error("Invalid live projection")
  const seen = new Set<string>()
  const encoder = new TextEncoder()
  return value.parts.map((part) => {
    if (
      !record(part) ||
      typeof part.id !== "string" ||
      part.id.length > 256 ||
      !["text", "reasoning"].includes(String(part.kind)) ||
      typeof part.text !== "string" ||
      typeof part.truncated !== "boolean" ||
      encoder.encode(part.text).length > 256 * 1024
    )
      throw new Error("Invalid live part")
    const id = "live:" + value.messageID + ":" + part.kind + ":" + part.id
    if (seen.has(id)) throw new Error("Duplicate live part")
    seen.add(id)
    return {
      id,
      role: part.kind === "reasoning" ? "activity" : "assistant",
      text: part.text + (part.truncated ? "\n实时预览已达长度上限，完整内容将在完成后同步。" : ""),
    }
  })
}
function paint(messages: Message[], live: Message[] = []) {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
  timeline.replaceChildren()
  for (const message of [...messages, ...live]) {
    const item = document.createElement("article")
    item.className = "message " + message.role
    if (live.includes(message)) item.dataset.live = "true"
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
  diffDialog.close()
  diffContent.replaceChildren()
  diffButton.disabled = !approved.permissions.includes("read")
  renameDialog.close()
  pendingSignature = ""
  pending.replaceChildren()
  pendingNodes.clear()
  observedExecutionID = undefined
  interrupt.disabled = true
  selectionDialog.close()
  selectionScope = undefined
  selectionModels = []
  selectionButton.disabled = !approved.permissions.includes("session.selection")
  rename.disabled = !approved.permissions.includes("session.rename")
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
    const decisions = await connection.request("session.pending", { sessionID })
    if (current !== generation) return
    showPending(decisions, partition)
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
    const live = decodeLive(page.live)
    if (!page.data.length) {
      paint(messages, live)
      continue
    }
    let next = cursor
    const projected = [...messages]
    let updatedTitle: string | undefined
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
      if (event.type === "session.next.info.updated" && typeof event.data.title === "string")
        updatedTitle = event.data.title
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
    if (updatedTitle !== undefined) updateTitle(partition.sessionID, updatedTitle)
    paint(messages, live)
  }
}
function updateTitle(sessionID: string, label: string) {
  title.textContent = label
  sessions.querySelectorAll("button").forEach((button) => {
    if (button.dataset.sessionId === sessionID) button.textContent = label
  })
}
async function perform(method: ControlAgent.Method, payload: unknown, expected: BrowserCheckpoint.Scope | undefined) {
  const connection = rpc
  const current = generation
  if (!connection || !expected || expected !== scope || !RemoteRPC.isWrite(method)) throw new Error("Session changed")
  const prepared = await cache.prepareOperation(expected, {
    id: crypto.randomUUID(),
    method,
    payload: JSON.stringify(payload),
  })
  const claimed = await cache.transitionOperation(expected, prepared.id, prepared.revision, "awaitingConfirmation")
  if (current !== generation || expected !== scope) {
    await cache.transitionOperation(expected, prepared.id, claimed.revision, "rejected")
    throw new Error("Session changed")
  }
  const result = await connection
    .request(method, { sessionID: expected.sessionID, operationID: prepared.id, payload })
    .catch((error: unknown) => error)
  const rejected =
    result instanceof RemoteRPC.RequestError &&
    ["forbidden", "invalid_request", "conflict", "not_found", "expired"].includes(result.code)
  const status =
    rejected || (record(result) && result.status === "rejected")
      ? "rejected"
      : record(result) && result.status === "completed"
        ? "completed"
        : "outcomeUnknown"
  await cache.transitionOperation(
    expected,
    prepared.id,
    claimed.revision,
    status,
    result instanceof Error ? undefined : JSON.stringify(result),
  )
  if (status !== "completed") {
    if (current === generation)
      report(
        status === "rejected"
          ? "操作未执行，任务或授权可能已变化。请刷新后重新选择。"
          : "操作结果尚未确认。重连时只查询状态，不会自动重试。",
      )
    return false
  }
  if (current !== generation) return false
  pendingSignature = ""
  return true
}
function showPending(value: unknown, partition: BrowserCheckpoint.Scope) {
  if (
    !record(value) ||
    !Array.isArray(value.permissions) ||
    !Array.isArray(value.questions) ||
    value.permissions.length > 128 ||
    value.questions.length > 32 ||
    !record(value.execution)
  )
    throw new Error("Invalid pending decisions")
  const permissions = Schema.decodeUnknownSync(Schema.Array(Permission.Request))(value.permissions)
  const questions = Schema.decodeUnknownSync(Schema.Array(Question.Request))(value.questions)
  observedExecutionID =
    value.execution.type === "running" && typeof value.execution.executionID === "string"
      ? value.execution.executionID
      : undefined
  interrupt.disabled = !observedExecutionID || !grant?.permissions.includes("interrupt")
  const signature = JSON.stringify([permissions, questions])
  if (signature === pendingSignature) return
  pendingSignature = signature
  const keys = new Set([
    ...permissions.map((request) => "permission:" + request.id),
    ...questions.map((request) => "question:" + request.id),
  ])
  for (const [key, item] of pendingNodes) {
    if (keys.has(key)) continue
    item.node.remove()
    pendingNodes.delete(key)
  }
  for (const request of permissions) {
    if (request.sessionID !== partition.sessionID) throw new Error("Decision session mismatch")
    const key = "permission:" + request.id
    const fingerprint = JSON.stringify(request)
    const existing = pendingNodes.get(key)
    if (existing?.fingerprint === fingerprint && existing.node.isConnected) continue
    existing?.node.remove()
    const card = document.createElement("article")
    card.className = "decision"
    const heading = document.createElement("h3")
    heading.textContent = "需要你的授权"
    const description = document.createElement("pre")
    description.textContent = request.action + "\n" + request.resources.join("\n")
    card.append(heading, description)
    for (const action of [
      { text: "允许这一次", reply: "once" },
      { text: "拒绝", reply: "reject" },
    ]) {
      const button = document.createElement("button")
      button.textContent = action.text
      button.disabled = !grant?.permissions.includes("permission.reply")
      button.onclick = () =>
        run(async () => {
          card.querySelectorAll("button").forEach((button) => {
            button.disabled = true
          })
          const completed = await perform("permission.reply", { requestID: request.id, reply: action.reply }, partition)
          if (completed) card.remove()
        })
      card.append(button)
    }
    pending.append(card)
    pendingNodes.set(key, { node: card, fingerprint })
  }
  for (const request of questions) {
    if (request.sessionID !== partition.sessionID) throw new Error("Decision session mismatch")
    const key = "question:" + request.id
    const fingerprint = JSON.stringify(request)
    const existing = pendingNodes.get(key)
    if (existing?.fingerprint === fingerprint && existing.node.isConnected) continue
    existing?.node.remove()
    const form = document.createElement("form")
    form.className = "decision"
    const groups = request.questions.map((question) => {
      const field = document.createElement("fieldset")
      const legend = document.createElement("legend")
      legend.textContent = question.question
      field.append(legend)
      const name = crypto.randomUUID()
      const options = question.options.map((option) => {
        const label = document.createElement("label")
        const input = document.createElement("input")
        input.type = question.multiSelect ? "checkbox" : "radio"
        input.name = name
        input.value = option.label
        label.append(input, document.createTextNode(option.label + " · " + option.description))
        field.append(label)
        return input
      })
      const custom = document.createElement("input")
      custom.type = "text"
      custom.maxLength = 16384
      if (question.custom !== false) {
        const label = document.createElement("label")
        label.textContent = "自己的回答"
        label.append(custom)
        field.append(label)
      }
      field.disabled = !grant?.permissions.includes("question.reply")
      form.append(field)
      return { options, custom, multiple: question.multiSelect === true }
    })
    const answer = document.createElement("button")
    answer.textContent = "提交回答"
    answer.type = "submit"
    const reject = document.createElement("button")
    reject.textContent = "跳过问题"
    reject.type = "button"
    reject.className = "quiet"
    answer.disabled = reject.disabled = !grant?.permissions.includes("question.reply")
    form.append(answer, reject)
    form.onsubmit = (event) => {
      event.preventDefault()
      run(async () => {
        const answers = groups.map((group) => {
          const selected = group.options.filter((input) => input.checked).map((input) => input.value)
          const text = group.custom.value.trim()
          return text ? (group.multiple ? [...selected, text] : [text]) : selected
        })
        if (answers.some((answer) => !answer.length)) {
          report("请回答每一个问题，再提交。")
          return
        }
        answer.disabled = reject.disabled = true
        if (await perform("question.reply", { requestID: request.id, answers }, partition)) form.remove()
      })
    }
    reject.onclick = () =>
      run(async () => {
        answer.disabled = reject.disabled = true
        if (await perform("question.reply", { requestID: request.id, reject: true }, partition)) form.remove()
      })
    pending.append(form)
    pendingNodes.set(key, { node: form, fingerprint })
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
    await resumePairing()
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
rename.onclick = () => {
  renameScope = scope
  get("rename-title", HTMLInputElement).value = title.textContent ?? ""
  renameDialog.showModal()
}
function populateVariants() {
  const model = modelChoice.value === "" ? undefined : selectionModels[Number(modelChoice.value)]
  variantChoice.replaceChildren(
    new Option("默认", ""),
    ...(model?.variants.map((variant) => new Option(variant.id, variant.id)) ?? []),
  )
}
modelChoice.onchange = populateVariants
get("selection-close", HTMLButtonElement).onclick = () => selectionDialog.close()
selectionButton.onclick = () =>
  run(async () => {
    const connection = rpc
    const partition = scope
    const current = generation
    if (!connection || !partition || selectionButton.disabled) return
    selectionButton.disabled = true
    try {
      const value = await connection.request("selection.list", { sessionID: partition.sessionID })
      if (current !== generation || partition !== scope || connection !== rpc) return
      if (
        !record(value) ||
        !Array.isArray(value.agents) ||
        value.agents.length > 256 ||
        !Array.isArray(value.models) ||
        value.models.length > 4096
      )
        throw new Error("Invalid selections")
      const agents = value.agents.map((agent) => {
        if (!record(agent) || typeof agent.id !== "string") throw new Error("Invalid agent")
        return agent.id
      })
      selectionModels = value.models.map((model) => {
        if (
          !record(model) ||
          typeof model.id !== "string" ||
          typeof model.providerID !== "string" ||
          typeof model.name !== "string" ||
          !Array.isArray(model.variants) ||
          model.variants.length > 256
        )
          throw new Error("Invalid model")
        return {
          id: model.id,
          providerID: model.providerID,
          name: model.name,
          variants: model.variants.map((variant) => {
            if (!record(variant) || typeof variant.id !== "string") throw new Error("Invalid variant")
            return { id: variant.id }
          }),
        }
      })
      agentChoice.replaceChildren(new Option("请选择 Agent", ""), ...agents.map((id) => new Option(id, id)))
      modelChoice.replaceChildren(
        new Option("请选择模型", ""),
        ...selectionModels.map((model, index) => new Option(model.providerID + " / " + model.name, String(index))),
      )
      populateVariants()
      selectionScope = partition
      selectionDialog.showModal()
    } finally {
      if (current === generation) selectionButton.disabled = false
    }
  })
get("agent-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  const partition = selectionScope
  const agent = agentChoice.value
  if (!agent || partition !== scope) return
  selectionDialog.close()
  run(async () => {
    if (await perform("session.switchAgent", { agent }, partition)) report("Agent 已更新，下次模型调用起生效。")
  })
}
get("model-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  const partition = selectionScope
  const model = modelChoice.value === "" ? undefined : selectionModels[Number(modelChoice.value)]
  const variant = variantChoice.value
  if (!model || partition !== scope || (variant && !model.variants.some((item) => item.id === variant))) return
  const payload = { model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) } }
  selectionDialog.close()
  run(async () => {
    if (await perform("session.switchModel", payload, partition)) report("模型已更新，下次模型调用起生效。")
  })
}
get("rename-cancel", HTMLButtonElement).onclick = () => renameDialog.close()
get("diff-close", HTMLButtonElement).onclick = () => diffDialog.close()
diffButton.onclick = () =>
  run(async () => {
    const connection = rpc
    const partition = scope
    const current = generation
    if (!connection || !partition || diffButton.disabled) return
    diffButton.disabled = true
    try {
      const value = await connection.request("session.diff", { sessionID: partition.sessionID })
      if (current !== generation || connection !== rpc || partition !== scope) return
      if (!Array.isArray(value) || value.length > 2048) throw new Error("Invalid file changes")
      const files = Schema.decodeUnknownSync(Schema.Array(Revert.FileDiff))(value)
      const items = files.map((file) => {
        const section = document.createElement("section")
        const heading = document.createElement("h3")
        heading.textContent = file.path + " · +" + file.additions + " −" + file.deletions
        const patch = document.createElement("pre")
        patch.textContent = file.patch
        section.append(heading, patch)
        return section
      })
      diffContent.replaceChildren(...items)
      if (!items.length) diffContent.textContent = "当前会话还没有文件变化。"
      diffDialog.showModal()
    } finally {
      if (current === generation) diffButton.disabled = false
    }
  })
get("rename-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  run(async () => {
    const label = get("rename-title", HTMLInputElement).value.trim()
    if (!label) return
    renameDialog.close()
    if (await perform("session.rename", { title: label }, renameScope)) {
      if (renameScope) updateTitle(renameScope.sessionID, label)
      report("会话名称已更新。")
    }
  })
}
interrupt.onclick = () =>
  run(async () => {
    const partition = scope
    const executionID = observedExecutionID
    if (!executionID || interrupt.disabled) return
    interrupt.disabled = true
    if (await perform("session.interrupt", { executionID }, partition)) report("已请求停止当前任务。")
  })
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
    sessionStorage.removeItem("miao.remote-control.invitation")
    await loginMethods()
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
    const host = discovered.find(
      (host) =>
        host.hostID === hostID && host.runtimeID === selected?.runtimeID && host.online && host.revokedAt === null,
    )
    if (!host) {
      report("电脑暂时离线。可在恢复连接后继续。")
      return
    }
    await connect(host)
    if (sessionID) await openSession(sessionID, label)
  })
})
// Clear callback codes and invitation fragments before any asynchronous requests.
const callbackSearch = new URLSearchParams(location.search).get("miao_login") === "1" ? location.search : undefined
const scannedInvitation = location.hash.startsWith("#pair=") ? location.href : undefined
let invalidScannedInvitation = false
if (callbackSearch || scannedInvitation) history.replaceState(null, "", location.pathname)
if (scannedInvitation) {
  try {
    const invitation = PairingLink.parse(scannedInvitation, location.origin, loopback())
    sessionStorage.setItem("miao.remote-control.invitation", JSON.stringify(invitation))
  } catch {
    invalidScannedInvitation = true
    sessionStorage.removeItem("miao.remote-control.invitation")
  }
}
async function resumePairing() {
  const raw = sessionStorage.getItem("miao.remote-control.invitation")
  if (!raw) return
  sessionStorage.removeItem("miao.remote-control.invitation")
  PairingLink.parse(raw, location.origin, loopback())
  get("invitation", HTMLTextAreaElement).value = raw
  await pair()
}
async function loginMethods() {
  const providers = await account.providers()
  get("login-form", HTMLFormElement).hidden = providers.length > 0
  const social = get("social-login", HTMLDivElement)
  social.replaceChildren()
  social.hidden = !providers.length
  for (const provider of providers) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = provider === "github" ? "使用 GitHub 登录" : "使用 Google 登录"
    button.onclick = () =>
      run(async () => {
        location.assign(await account.beginSocial(provider))
      })
    social.append(button)
  }
}
window.addEventListener("pagehide", disconnect)
run(async () => {
  if (!window.isSecureContext || !navigator.locks) throw new Error("HTTPS required")
  identity = await BrowserIdentity.load()
  cache = await BrowserCheckpoint.open()
  let session
  try {
    session = callbackSearch ? await account.completeSocial(callbackSearch) : await account.restore()
  } catch {
    login.hidden = false
    directory.hidden = true
    await loginMethods()
    report("登录未完成，请重新选择登录方式。")
    return
  }
  login.hidden = !!session
  directory.hidden = !session
  if (session) {
    await refresh()
    await resumePairing()
  } else await loginMethods()
  if (invalidScannedInvitation) report("扫码邀请无效或已过期，请在电脑重新生成。")
  else if (account.revocationPending()) report("上次退出尚未确认。请重新登录以完成退出重试。")
})
