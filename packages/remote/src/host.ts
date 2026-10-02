// The host turns saved accounts into running channels and runs logins. It owns
// what every connector shares: the credentials file, per-account state
// directories, the owner gate, pairing codes, and status. The Router only sees
// plain Channels whose IDs are "<connector>/<account>".
import { readJson } from "./file"
import { accountDirectory, channelID, readAccounts, updateAccount, type AccountRecord } from "./accounts"
import type { Channel, Inbound, SendResult } from "./channel"
import type { AccountInfo, Connector, LoginInput, LoginStep } from "./connector"
import { lockHolder } from "./lock"
import { routerStatus } from "./router"
import path from "node:path"

/** A login step as interfaces see it: credentials stay inside the host, pairing is added. */
export type FlowStep =
  | Exclude<LoginStep, { type: "done" }>
  | {
      readonly type: "pair"
      readonly code: string
      readonly expiresAt: number
      readonly link?: string
      readonly hint: string
    }
  | { readonly type: "done"; readonly connector: string; readonly account: AccountInfo; readonly message?: string }

export type LoginFlow = {
  readonly id: string
  readonly connector: string
  /** Every step so far, oldest first. */
  readonly steps: () => ReadonlyArray<FlowStep>
  readonly finished: () => boolean
  /** Replays past steps, then follows new ones until the flow finishes. */
  readonly events: (signal?: AbortSignal) => AsyncIterable<FlowStep>
  /** Answers the pending code or form step. False when nothing is waiting. */
  readonly input: (value: LoginInput) => boolean
  readonly cancel: () => void
}

export type AccountState = "connected" | "connecting" | "retrying" | "needs-login" | "unpaired" | "offline" | "error"

export type AccountStatus = {
  readonly connector: string
  readonly account: string
  readonly label: string
  readonly state: AccountState
  /** The connector's own state word, such as "polling". */
  readonly detail?: string
  readonly owner?: string
  readonly pairing?: { readonly expiresAt: number }
  readonly error?: string
  readonly lastActivityAt?: number
  /** Process currently running this account's channel. */
  readonly pid?: number
  readonly pushesToday: number
  readonly pushBudget?: number
  readonly pending: number
  readonly approvals: number
}

export type ConnectorStatus = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly transport?: "poll" | "socket" | "webhook"
  readonly pairing: boolean
  readonly notice?: string
  readonly accounts: ReadonlyArray<AccountStatus>
}

/** Where hot-added channels go; the Router implements it. */
export type Sink = {
  readonly add: (channel: Channel) => Promise<void>
  readonly remove: (id: string) => Promise<void>
}

export type HostOptions = {
  readonly authFile: string
  readonly stateDir: string
  readonly connectors: ReadonlyArray<Connector>
  /** Settings for one connector, from `remote.<id>` in the global config. */
  readonly options?: (connector: string) => Readonly<Record<string, unknown>>
  readonly agentVersion: string
  readonly fetch?: typeof fetch
  readonly log?: (message: string) => void
  readonly now?: () => number
  readonly pairTtlMs?: number
  readonly loginTimeoutMs?: number
}

type Live = {
  readonly connector: Connector
  readonly account: AccountInfo
  readonly channel: Channel
  readonly inner: Channel
  record: AccountRecord
  wrongCodes: number
  /** Started by the host itself only to receive a pairing code (no Router attached). */
  pairingOnly: boolean
}

const PairTtlMs = 10 * 60_000
const MaxWrongCodes = 10
const FlowRetentionMs = 10 * 60_000

export const PairedMessage = "配对成功：这个机器人现在只接受你的消息。发 /help 查看用法。"
export const TestMessage = "miao 测试消息：连接正常。"

export function createHost(options: HostOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const request = options.fetch ?? fetch
  const connectors = new Map(options.connectors.map((connector) => [connector.id, connector]))
  const live = new Map<string, Live>()
  const flows = new Map<string, ReturnType<typeof createFlow>>()
  const pairWaiters = new Map<string, Set<() => void>>()
  const runtime = { sink: undefined as Sink | undefined }

  return {
    connectors: () => [...connectors.values()],
    connector: (id: string) => connectors.get(id),
    open,
    bind,
    channels: () => [...live.values()].filter((item) => !item.pairingOnly).map((item) => item.channel),
    allow,
    status,
    login,
    flow: (id: string) => flows.get(id)?.flow,
    remove,
    pair,
    test,
    close,
  }

  /** Builds channels for every usable saved account. They start when the Router starts them. */
  async function open() {
    const accounts = await readAccounts(options.authFile)
    const failures: Array<{ readonly id: string; readonly error: string }> = []
    for (const [connectorID, records] of Object.entries(accounts)) {
      const connector = connectors.get(connectorID)
      if (!connector) {
        if (Object.keys(records).length > 0)
          log(`remote: no connector "${connectorID}" is installed; its accounts stay off`)
        continue
      }
      for (const [accountID, record] of Object.entries(records)) {
        if (record.needsLogin) continue
        const built = await build(connector, { id: accountID, label: record.label }, record).catch((error: unknown) =>
          errorText(error),
        )
        if (typeof built === "string") failures.push({ id: channelID(connectorID, accountID), error: built })
      }
    }
    return { channels: [...live.values()].map((item) => item.channel), failures }
  }

  /** Later logins, removals, and re-pairs are applied to this sink while it is bound. */
  function bind(sink: Sink | undefined) {
    runtime.sink = sink
  }

  function allow(channel: string, user: string) {
    return live.get(channel)?.record.owner === user
  }

  async function build(connector: Connector, account: AccountInfo, record: AccountRecord) {
    const credentials = connector.parse(record.credentials)
    if (credentials === undefined) throw new Error(`${connector.name}的凭证无法识别，请重新登录`)
    const id = channelID(connector.id, account.id)
    const entry: { current?: Live } = {}
    const inner = await connector.connect(credentials, {
      account,
      owner: () => entry.current?.record.owner,
      stateDir: accountDirectory(options.stateDir, connector.id, account.id),
      options: options.options?.(connector.id) ?? {},
      agentVersion: options.agentVersion,
      fetch: request,
      log,
      now,
      markNeedsLogin: async (reason) => {
        const next = await updateAccount(options.authFile, connector.id, account.id, (current) =>
          current ? { ...current, needsLogin: { at: now(), reason } } : undefined,
        )
        if (next && entry.current) entry.current.record = next
      },
    })
    const channel: Channel = {
      ...inner,
      id,
      start: (onMessage) => inner.start((message) => gate(id, message, onMessage)),
    }
    const item: Live = { connector, account, channel, inner, record, wrongCodes: 0, pairingOnly: false }
    entry.current = item
    live.set(id, item)
    return item
  }

  // Only the owner reaches the Router. While a pairing code is active, the first
  // person who sends it becomes the owner.
  async function gate(id: string, message: Inbound, onMessage: (message: Inbound) => Promise<void>) {
    const item = live.get(id)
    if (!item) return
    const pairing = item.record.pair
    if (pairing && pairing.expiresAt > now() && normalizeCode(message.text) === pairing.code) {
      const record = await updateAccount(options.authFile, item.connector.id, item.account.id, (current) => {
        if (!current) return undefined
        const { pair: _pair, ...rest } = current
        return { ...rest, owner: message.user }
      })
      if (!record) return
      item.record = record
      item.wrongCodes = 0
      log(`remote: ${id} paired with its owner`)
      await item.inner.send(message.user, PairedMessage, message.reply).catch(() => undefined)
      pairWaiters.get(id)?.forEach((wake) => wake())
      return
    }
    if (item.record.owner === message.user) {
      if (!item.pairingOnly) await onMessage(message)
      return
    }
    if (pairing && pairing.expiresAt > now() && /^\d{6}$/.test(normalizeCode(message.text))) {
      item.wrongCodes += 1
      if (item.wrongCodes >= MaxWrongCodes) await expirePairing(item, "wrong codes")
    }
    log(`remote: ignored a message to ${id} from someone who is not its owner`)
  }

  async function expirePairing(item: Live, why: string) {
    const record = await updateAccount(options.authFile, item.connector.id, item.account.id, (current) => {
      if (!current) return undefined
      const { pair: _pair, ...rest } = current
      return rest
    })
    if (record) item.record = record
    log(`remote: pairing code for ${channelID(item.connector.id, item.account.id)} withdrawn (${why})`)
    pairWaiters.get(channelID(item.connector.id, item.account.id))?.forEach((wake) => wake())
  }

  async function status(): Promise<ConnectorStatus[]> {
    const accounts = await readAccounts(options.authFile)
    const users = await routerStatus(path.join(options.stateDir, "router.json"), now())
    return Promise.all(
      [...connectors.values()].map(async (connector) => ({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        transport: connector.transport,
        pairing: connector.pairing === true,
        notice: connector.notice,
        accounts: await Promise.all(
          Object.entries(accounts[connector.id] ?? {}).map(async ([accountID, record]) => {
            const id = channelID(connector.id, accountID)
            const directory = accountDirectory(options.stateDir, connector.id, accountID)
            const file = (await readJson(path.join(directory, "status.json"))) as
              | { state?: string; at?: number; lastPollAt?: number; error?: string }
              | undefined
            const pid = await lockHolder(path.join(directory, "lock"))
            const item = live.get(id)
            const user = record.owner ? users.find((entry) => entry.key === `${id}:${record.owner}`) : undefined
            const budget = item?.channel.capabilities.pushBudgetPerDay ?? connector.capabilities.pushBudgetPerDay
            return {
              connector: connector.id,
              account: accountID,
              label: record.label,
              state: accountState(record, file?.state, item !== undefined || pid !== undefined),
              detail: file?.state,
              owner: record.owner ? mask(record.owner) : undefined,
              pairing: record.pair && record.pair.expiresAt > now() ? { expiresAt: record.pair.expiresAt } : undefined,
              error: record.needsLogin?.reason ?? file?.error,
              lastActivityAt: file?.lastPollAt ?? file?.at,
              pid,
              pushesToday: user?.pushesToday ?? 0,
              pushBudget: budget,
              pending: user?.pending ?? 0,
              approvals: user?.approvals ?? 0,
            } satisfies AccountStatus
          }),
        ),
      })),
    )
  }

  function accountState(record: AccountRecord, detail: string | undefined, running: boolean): AccountState {
    if (record.needsLogin || detail === "needs-login") return "needs-login"
    if (!record.owner) return "unpaired"
    if (!running) return "offline"
    if (detail === "retrying") return "retrying"
    if (detail === "error") return "error"
    if (detail === "starting" || detail === undefined) return "connecting"
    if (detail === "stopped") return "offline"
    return "connected"
  }

  function login(connectorID: string) {
    const connector = connectors.get(connectorID)
    if (!connector) throw new Error(`没有名为 ${connectorID} 的连接器`)
    const created = createFlow(connector)
    flows.set(created.flow.id, created)
    void created.done.finally(() => {
      const timer = setTimeout(() => flows.delete(created.flow.id), FlowRetentionMs)
      timer.unref?.()
    })
    return created.flow
  }

  function createFlow(connector: Connector) {
    const id = crypto.randomUUID()
    const abort = new AbortController()
    const steps: FlowStep[] = []
    const listeners = new Set<() => void>()
    const state = { finished: false, answer: undefined as ((value: LoginInput) => void) | undefined }
    const timeout = setTimeout(() => abort.abort(), options.loginTimeoutMs ?? 15 * 60_000)
    timeout.unref?.()
    const emit = (step: FlowStep) => {
      steps.push(step)
      listeners.forEach((wake) => wake())
    }
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
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
    const waitInput = () =>
      new Promise<LoginInput | undefined>((resolve) => {
        state.answer = (value) => {
          state.answer = undefined
          resolve(value)
        }
        abort.signal.addEventListener(
          "abort",
          () => {
            state.answer = undefined
            resolve(undefined)
          },
          { once: true },
        )
      })

    const done = run()
      .catch((error: unknown) => emit({ type: "error", message: errorText(error) }))
      .finally(() => {
        clearTimeout(timeout)
        state.finished = true
        listeners.forEach((wake) => wake())
      })

    const flow: LoginFlow = {
      id,
      connector: connector.id,
      steps: () => steps,
      finished: () => state.finished,
      input: (value) => {
        if (!state.answer) return false
        state.answer(value)
        return true
      },
      cancel: () => abort.abort(),
      events: (signal) => ({
        [Symbol.asyncIterator]: async function* () {
          const cursor = { index: 0 }
          while (true) {
            while (cursor.index < steps.length) yield steps[cursor.index++]
            if (state.finished || signal?.aborted) return
            await new Promise<void>((resolve) => {
              const wake = () => {
                listeners.delete(wake)
                resolve()
              }
              listeners.add(wake)
              signal?.addEventListener("abort", wake, { once: true })
            })
          }
        },
      }),
    }
    return { flow, done }

    async function run() {
      const generator = connector.login({
        fetch: request,
        signal: abort.signal,
        options: options.options?.(connector.id) ?? {},
        log,
        now,
        sleep,
      })
      const cursor = { input: undefined as LoginInput | undefined }
      while (true) {
        const next = await generator.next(cursor.input)
        cursor.input = undefined
        if (abort.signal.aborted) {
          await generator.return(undefined).catch(() => undefined)
          return emit({ type: "error", message: "登录已取消或超时" })
        }
        if (next.done) return emit({ type: "error", message: "登录没有完成" })
        const step = next.value
        if (step.type === "done") return finish(step)
        emit(step)
        if (step.type === "error") return
        if (step.type !== "code" && step.type !== "form") continue
        cursor.input = await waitInput()
        if (cursor.input === undefined) {
          await generator.return(undefined).catch(() => undefined)
          return emit({ type: "error", message: "登录已取消或超时" })
        }
      }
    }

    async function finish(step: Extract<LoginStep, { type: "done" }>) {
      if (connector.parse(step.credentials) === undefined)
        return emit({ type: "error", message: "登录返回的凭证不完整，请重试" })
      const pairing = step.owner ? undefined : newPair()
      const record = await updateAccount(options.authFile, connector.id, step.account.id, (current) => ({
        label: step.account.label,
        // A new QR login names its owner; a login that cannot tell keeps a previous owner until pairing replaces it.
        ...(step.owner ? { owner: step.owner } : current?.owner ? { owner: current.owner } : {}),
        ...(pairing ? { pair: pairing } : {}),
        savedAt: now(),
        credentials: step.credentials,
      }))
      if (!record) return emit({ type: "error", message: "保存凭证失败" })
      log(`remote: saved ${connector.id} account ${step.account.id}`)
      const id = channelID(connector.id, step.account.id)
      await restart(connector, step.account, record)
      if (!pairing) return emit({ type: "done", connector: connector.id, account: step.account, message: step.message })
      emit(pairStep(connector, record, pairing))
      const paired = await waitPaired(id, pairing.expiresAt, abort.signal)
      if (!paired) return emit({ type: "error", message: "配对码已过期或被撤销，可以在列表里重新配对" })
      emit({ type: "done", connector: connector.id, account: step.account, message: "配对成功" })
    }
  }

  /** Replaces the running channel of an account after its credentials or pairing changed. */
  async function restart(connector: Connector, account: AccountInfo, record: AccountRecord) {
    const id = channelID(connector.id, account.id)
    await stopLive(id)
    if (!runtime.sink && !record.pair) return
    const item = await build(connector, account, record).catch((error: unknown) => {
      log(`remote: could not connect ${id}: ${errorText(error)}`)
      return undefined
    })
    if (!item) return
    if (runtime.sink)
      return runtime.sink.add(item.channel).catch((error: unknown) => {
        log(`remote: could not start ${id}: ${errorText(error)}`)
      })
    // No Router in this process: listen only long enough to receive the pairing code.
    item.pairingOnly = true
    await item.channel
      .start(async () => undefined)
      .catch((error: unknown) => {
        log(`remote: could not start ${id} for pairing: ${errorText(error)}`)
      })
  }

  async function stopLive(id: string) {
    const item = live.get(id)
    if (!item) return
    live.delete(id)
    if (runtime.sink && !item.pairingOnly) return runtime.sink.remove(id)
    await item.channel.stop().catch(() => undefined)
  }

  function waitPaired(id: string, expiresAt: number, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const waiters = pairWaiters.get(id) ?? new Set<() => void>()
      pairWaiters.set(id, waiters)
      const finish = () => {
        clearTimeout(timer)
        waiters.delete(check)
        if (waiters.size === 0) pairWaiters.delete(id)
        const item = live.get(id)
        resolve(item !== undefined && item.record.owner !== undefined && item.record.pair === undefined)
      }
      const check = () => {
        const item = live.get(id)
        if (!item || item.record.pair === undefined || now() >= expiresAt) finish()
      }
      const timer = setTimeout(finish, Math.max(0, expiresAt - now()))
      waiters.add(check)
      signal.addEventListener("abort", finish, { once: true })
    })
  }

  function pairStep(connector: Connector, record: AccountRecord, pairing: { code: string; expiresAt: number }) {
    const credentials = connector.parse(record.credentials)
    const link = credentials === undefined ? undefined : connector.pairLink?.(credentials, pairing.code)
    return {
      type: "pair" as const,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      ...(link ? { link } : {}),
      hint: `${Math.round((pairing.expiresAt - now()) / 60_000)} 分钟内，用你自己的账号给机器人发送这 6 位数字；第一个发送的人成为主人`,
    }
  }

  function newPair() {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0")
    return { code, expiresAt: now() + (options.pairTtlMs ?? PairTtlMs) }
  }

  async function remove(connectorID: string, accountID: string) {
    const id = channelID(connectorID, accountID)
    await stopLive(id)
    const accounts = await readAccounts(options.authFile)
    if (!accounts[connectorID]?.[accountID]) return false
    await updateAccount(options.authFile, connectorID, accountID, () => undefined)
    log(`remote: removed ${id}`)
    return true
  }

  /** Issues a new pairing code. The current owner keeps access until someone sends it. */
  async function pair(
    connectorID: string,
    accountID: string,
  ): Promise<
    | { readonly ok: true; readonly step: Extract<FlowStep, { type: "pair" }> }
    | { readonly ok: false; readonly unknown: boolean; readonly message: string }
  > {
    const connector = connectors.get(connectorID)
    const existing = (await readAccounts(options.authFile))[connectorID]?.[accountID]
    if (!connector || !existing) return { ok: false, unknown: true, message: "账号不存在" }
    if (existing.owner && connector.pairing !== true)
      return {
        ok: false,
        unknown: false,
        message: `${connector.name}在登录时已经确定主人，不需要配对；换主人请重新登录`,
      }
    const pairing = newPair()
    const record = await updateAccount(options.authFile, connectorID, accountID, (current) =>
      current ? { ...current, pair: pairing } : undefined,
    )
    if (!record) return { ok: false, unknown: true, message: "账号不存在" }
    const item = live.get(channelID(connectorID, accountID))
    if (!item) await restart(connector, { id: accountID, label: record.label }, record)
    if (item) {
      item.record = record
      item.wrongCodes = 0
    }
    return { ok: true, step: pairStep(connector, record, pairing) }
  }

  /** Sends the test message to the owner; undefined when the account does not exist. */
  async function test(connectorID: string, accountID: string): Promise<SendResult | undefined> {
    if (!(await readAccounts(options.authFile))[connectorID]?.[accountID]) return undefined
    const item = live.get(channelID(connectorID, accountID))
    if (!item || item.pairingOnly) return { ok: false, sent: 0, error: "这个账号没有在本进程里运行" }
    const owner = item.record.owner
    if (!owner) return { ok: false, sent: 0, error: "还没有配对主人" }
    return item.inner
      .send(owner, TestMessage)
      .catch((error: unknown) => ({ ok: false, sent: 0, error: errorText(error) }))
  }

  async function close() {
    flows.forEach((entry) => entry.flow.cancel())
    const pairingOnly = [...live.values()].filter((item) => item.pairingOnly)
    await Promise.all(pairingOnly.map((item) => stopLive(channelID(item.connector.id, item.account.id))))
  }
}

/** Accepts "123456", "/start 123456", and spaced or full-width digits. */
function normalizeCode(text: string) {
  return text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/^\/start\b/i, "")
    .replace(/\s+/g, "")
}

export function mask(value: string) {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-6)}`
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type Host = ReturnType<typeof createHost>
