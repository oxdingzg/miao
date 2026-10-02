// Channel-agnostic session routing for `miao remote`.
//
// The Router turns IM text into V2 protocol calls and V2 events back into short
// IM messages. It only talks to the miao server through the generated client,
// so it can later move to another process or behind a relay unchanged.
import os from "node:os"
import path from "node:path"
import type { OpenCode } from "@miao/client"
import type { Capabilities, Channel, Inbound, SendResult } from "./channel"
import { readJson, writer } from "./file"

export type Client = ReturnType<typeof OpenCode.make>

export type RouterOptions = {
  readonly client: Client
  readonly channels: ReadonlyArray<Channel>
  /** Project alias → directory. Only sessions inside these directories can be listed or driven. */
  readonly projects: Readonly<Record<string, string>>
  /** Channel ID → the only users whose messages are accepted. */
  readonly allow: Readonly<Record<string, ReadonlyArray<string>>>
  /** Path of the router state file (numbers, current session, approval codes, pending results). */
  readonly state: string
  readonly approvalTtlMs?: number
  /**
   * Model for sessions created with /new. Passed explicitly because a session
   * without one resolves its model from the location catalog, which can still be
   * loading on a fresh location and then picks an arbitrary model.
   */
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  /** Command shown when a session must be opened on the desktop first. */
  readonly attach?: string
  readonly now?: () => number
  readonly log?: (message: string) => void
}

export type Router = Awaited<ReturnType<typeof createRouter>>

type Question = {
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiSelect?: boolean
  readonly custom?: boolean
}

type Approval = {
  readonly kind: "permission" | "question"
  readonly sessionID: string
  readonly requestID: string
  readonly expires: number
  readonly questions?: ReadonlyArray<Question>
}

type UserState = {
  current?: number
  next: number
  /** Short number → Session ID. Numbers are never reused, so an old "#3" never silently means another session. */
  sessions: Record<string, string>
  approvals: Record<string, Approval>
  nextCode: number
  /** Results that could not be delivered inside a reply window. */
  pending: Array<{ readonly text: string; readonly at: number }>
  pushes: { day: string; count: number }
  lastInboundAt: number
  /** Messages sent since the last inbound message. */
  replies: number
}

type Turn = {
  readonly tools: number
  readonly toolNames: Readonly<Record<string, number>>
  readonly files: ReadonlyArray<string>
  readonly cost: number
  readonly durationMs: number
  readonly error?: string
  readonly interrupted?: boolean
  readonly finishedAt: number
}

type SessionState = {
  /** The session ran or was created in this server process, so this process may drive it. */
  local: boolean
  /** User key that last drove the session; approvals and results go to them. */
  driver?: string
  lastTurn?: Turn
}

type State = {
  version: 1
  users: Record<string, UserState>
  sessions: Record<string, SessionState>
}

type Context = {
  readonly channel: Channel
  readonly key: string
  readonly user: UserState
}

type Message = {
  readonly kind: "reply" | "approval" | "result" | "error"
  readonly text: string
  /** Short proactive notice used instead of `text` when the reply window has closed. */
  readonly notice?: string
}

type Watcher = {
  readonly key: string
  readonly channel: Channel
  readonly firstID: string
  readonly startedAt: number
  interrupted: boolean
}

type ContextMessage = Awaited<ReturnType<Client["sessions"]["context"]>>[number]
type Assistant = Extract<ContextMessage, { type: "assistant" }>
type SessionInfo = Awaited<ReturnType<Client["sessions"]["get"]>>

const DefaultApprovalTtl = 30 * 60_000
const ListLimit = 10

export async function createRouter(options: RouterOptions) {
  const client = options.client
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const ttl = options.approvalTtlMs ?? DefaultApprovalTtl
  const projects = Object.fromEntries(
    Object.entries(options.projects).map(([alias, directory]) => [alias, expandHome(directory)]),
  )
  const state = parseState(await readJson(options.state))
  const persist = writer(options.state, (error) => log(`remote: failed to save state: ${String(error)}`))
  const save = () => persist(() => state)
  const chains = new Map<string, Promise<void>>()
  const watchers = new Map<string, Watcher>()
  const replyContext = new Map<string, unknown>()
  const channels = new Map(options.channels.map((channel) => [channel.id, channel]))
  const abort = new AbortController()
  const background = new Set<Promise<unknown>>()
  const connected = Promise.withResolvers<void>()

  return {
    start,
    stop,
    /** Resolves once queued message handling, turn watchers, and state writes have settled. */
    settled,
  }

  async function start() {
    void subscribe()
    // Asks raised before the stream connects are recovered by resync, but waiting
    // here keeps the common path event-driven.
    await Promise.race([connected.promise, Bun.sleep(5000)])
    await Promise.all(options.channels.map((channel) => channel.start((message) => receive(channel, message))))
  }

  async function stop() {
    abort.abort()
    await Promise.all(options.channels.map((channel) => channel.stop()))
    await Promise.allSettled([...chains.values()])
    await save()
  }

  async function settled(): Promise<void> {
    const work = [...chains.values(), ...background]
    if (work.length === 0) return save()
    await Promise.allSettled(work)
    return settled()
  }

  function track(work: Promise<unknown>) {
    background.add(work)
    void work.finally(() => background.delete(work))
  }

  // Messages from one person are handled strictly in order; different people never block each other.
  function serial(key: string, task: () => Promise<void>) {
    const next = (chains.get(key) ?? Promise.resolve())
      .then(task)
      .catch((error) => log(`remote: handling failed for ${key}: ${String(error)}`))
    chains.set(key, next)
    void next.then(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    return next
  }

  function receive(channel: Channel, inbound: Inbound) {
    if (!(options.allow[channel.id] ?? []).includes(inbound.user)) {
      log(`remote: ignored message from unlisted ${channel.id} user ${inbound.user}`)
      return Promise.resolve()
    }
    const key = `${channel.id}:${inbound.user}`
    return serial(key, async () => {
      const context = { channel, key, user: userState(key) }
      context.user.lastInboundAt = now()
      context.user.replies = 0
      replyContext.set(key, inbound.reply)
      const text = inbound.text.trim()
      // Any inbound message opens a fresh reply window; spend it on held results first.
      if (text !== "/r") await flush(context, false)
      await command(context, text)
      await save()
    })
  }

  async function command(context: Context, text: string) {
    const targeted = /^#(\d+)\s+([\s\S]+)$/.exec(text)
    if (targeted) return targetedCommand(context, Number(targeted[1]), targeted[2].trim())
    const code = /^([yan])(\d+)$/i.exec(text)
    if (code) return approve(context, code[1].toLowerCase(), code[2])
    const answer = /^q(\d+)\s+([\s\S]+)$/i.exec(text)
    if (answer) return answerQuestion(context, answer[1], answer[2])
    if (!text.startsWith("/")) return prompt(context, undefined, text, "steer")
    const name = text.split(/\s+/, 1)[0]
    const argument = text.slice(name.length).trim()
    if (name === "/list") return list(context)
    if (name === "/use") return use(context, argument)
    if (name === "/new") {
      const alias = argument.split(/\s+/, 1)[0]
      return create(context, alias || undefined, argument.slice(alias.length).trim())
    }
    if (name === "/projects") return say(context, projectList())
    if (name === "/stop") return interrupt(context, parseNumber(argument))
    if (name === "/r") return flush(context, true)
    if (name === "/status") return status(context)
    if (name === "/queue")
      return argument ? prompt(context, undefined, argument, "queue") : say(context, "用法：/queue 消息")
    if (name === "/help") return say(context, help())
    return say(context, `不认识的命令 ${name}，发 /help 查看可用命令`)
  }

  function targetedCommand(context: Context, number: number, body: string) {
    if (body === "/stop") return interrupt(context, number)
    if (body.startsWith("/queue ")) return prompt(context, number, body.slice("/queue ".length).trim(), "queue")
    if (body.startsWith("/")) return say(context, `#${number} 后面只能跟消息、/stop 或 /queue 消息`)
    return prompt(context, number, body, "steer")
  }

  async function prompt(context: Context, number: number | undefined, text: string, delivery: "steer" | "queue") {
    const sessionID = number === undefined ? currentSession(context.user) : context.user.sessions[String(number)]
    if (!sessionID) return say(context, number === undefined ? noCurrent() : `没有 #${number}，先发 /list`)
    const target = await drivable(context.user, sessionID)
    if (typeof target === "string") return say(context, target)
    const label = sessionLabel(context.user, sessionID, target)
    const busy = watchers.has(sessionID) || sessionID in (await active())
    const admitted = await client.sessions
      .prompt({ sessionID, prompt: { text }, delivery })
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    if (!admitted.ok) return say(context, `${label} 发送失败：${errorText(admitted.error)}`)
    sessionState(sessionID).driver = context.key
    const ack = !busy
      ? `${label} 收到，处理中`
      : delivery === "queue"
        ? `${label} 已排队，当前这一轮结束后处理`
        : `${label} 已插入正在进行的这一轮`
    await say(context, ack)
    watch(context, sessionID, admitted.value.id)
  }

  function watch(context: Context, sessionID: string, firstID: string) {
    if (watchers.has(sessionID)) return
    const watcher: Watcher = {
      key: context.key,
      channel: context.channel,
      firstID,
      startedAt: now(),
      interrupted: false,
    }
    watchers.set(sessionID, watcher)
    void context.channel.typing(userOf(context.key), true).catch(() => undefined)
    track(
      waitIdle(sessionID).then(async () => {
        // Delete before any await so a prompt arriving now starts a new turn of its own.
        watchers.delete(sessionID)
        if (![...watchers.values()].some((other) => other.key === watcher.key))
          void watcher.channel.typing(userOf(watcher.key), false).catch(() => undefined)
        if (abort.signal.aborted) return
        const turn = await summarize(sessionID, watcher)
        await serial(watcher.key, async () => {
          const user = userState(watcher.key)
          sessionState(sessionID).lastTurn = turn.stats
          const info = await client.sessions.get({ sessionID }).catch(() => undefined)
          const label = sessionLabel(user, sessionID, info)
          const outcome = turn.stats.interrupted ? "已中断" : turn.stats.error ? "出错" : "完成"
          await deliver(
            { channel: watcher.channel, key: watcher.key, user },
            {
              kind: turn.stats.error ? "error" : "result",
              text: [
                `【${label}】${outcome}${turn.stats.error ? `：${turn.stats.error}` : ""}`,
                turn.text ? truncate(turn.text, watcher.channel.capabilities.maxLength - 200) : undefined,
                `—— ${statsLine(turn.stats)}`,
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
              notice: `【${label}】这一轮${outcome}，发 /r 取结果`,
            },
          )
          await save()
        })
      }),
    )
  }

  // session.wait is a long request; a dropped connection is not the end of the turn.
  async function waitIdle(sessionID: string): Promise<void> {
    const done = await client.sessions.wait({ sessionID }, { signal: abort.signal }).then(
      () => true,
      () => false,
    )
    if (done || abort.signal.aborted) return
    const running = await client.sessions.active().catch(() => undefined)
    if (running && !(sessionID in running)) return
    await Bun.sleep(1000)
    return waitIdle(sessionID)
  }

  async function summarize(sessionID: string, watcher: Watcher) {
    const messages = await client.sessions.context({ sessionID }).catch(() => [] as ContextMessage[])
    const start = messages.findIndex((message) => message.id === watcher.firstID)
    const turn =
      start >= 0 ? messages.slice(start) : messages.filter((message) => message.time.created >= watcher.startedAt)
    const assistants = turn.filter((message): message is Assistant => message.type === "assistant")
    const tools = assistants.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool" ? [part.name] : [])),
    )
    const texts = assistants.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : [])),
    )
    const error = assistants.at(-1)?.error?.message
    return {
      text: texts.at(-1),
      stats: {
        tools: tools.length,
        toolNames: tools.reduce<Record<string, number>>(
          (counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }),
          {},
        ),
        files: [...new Set(assistants.flatMap((message) => message.snapshot?.files ?? []))],
        cost: assistants.reduce((sum, message) => sum + (message.cost ?? 0), 0),
        durationMs: now() - watcher.startedAt,
        error: watcher.interrupted ? undefined : error,
        interrupted: watcher.interrupted || undefined,
        finishedAt: now(),
      } satisfies Turn,
    }
  }

  async function list(context: Context) {
    const sessions = await listSessions()
    if (sessions.length === 0) return say(context, `还没有会话。发 /new <项目> [内容] 新建，/projects 查看项目`)
    const running = await active()
    const waiting = new Set(liveApprovals(context.user).map((approval) => approval.sessionID))
    const rank = (session: SessionInfo) => (waiting.has(session.id) ? 0 : session.id in running ? 1 : 2)
    const shown = sessions.toSorted((a, b) => rank(a) - rank(b) || b.time.updated - a.time.updated).slice(0, ListLimit)
    const current = currentSession(context.user)
    const lines = shown.map((session) => {
      const number = numberOf(context.user, session.id)
      const status = waiting.has(session.id)
        ? "等你审批"
        : session.id in running
          ? "运行中"
          : state.sessions[session.id]?.lastTurn?.error
            ? "出错"
            : "空闲"
      return [
        `#${number}${session.id === current ? "*" : ""} ${projectOf(session.location.directory) ?? "?"}`,
        session.title || "（无标题）",
        status,
        ago(now() - session.time.updated),
        ...(state.sessions[session.id]?.local ? [] : ["只读"]),
      ].join(" · ")
    })
    return say(context, ["会话（* 为当前）：", ...lines, "/use N 切换 · #N 消息 定向发送"].join("\n"))
  }

  async function use(context: Context, argument: string) {
    const number = parseNumber(argument)
    if (number === undefined) return say(context, "用法：/use N（先发 /list 看编号）")
    const sessionID = context.user.sessions[String(number)]
    if (!sessionID) return say(context, `没有 #${number}，先发 /list`)
    const info = await client.sessions.get({ sessionID }).catch(() => undefined)
    if (!info) return say(context, `#${number} 已不存在`)
    context.user.current = number
    const note = state.sessions[sessionID]?.local ? "" : `\n注意：它不在 miao remote 的服务里，只能查看，不能驱动`
    return say(
      context,
      `当前会话：#${number} ${projectOf(info.location.directory) ?? "?"} · ${info.title || "（无标题）"}${note}`,
    )
  }

  async function create(context: Context, alias: string | undefined, text: string) {
    if (!alias) return say(context, `用法：/new <项目> [内容]\n${projectList()}`)
    const directory = projects[alias]
    if (!directory) return say(context, `没有这个项目别名：${alias}\n${projectList()}`)
    const created = await client.sessions
      .create({ location: { directory }, model: options.model })
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    if (!created.ok) return say(context, `新建失败：${errorText(created.error)}`)
    const session = sessionState(created.value.id)
    session.local = true
    session.driver = context.key
    const number = numberOf(context.user, created.value.id)
    context.user.current = number
    if (!text) return say(context, `已新建 #${number}（${alias}），已切换为当前会话`)
    return prompt(context, number, text, "steer")
  }

  async function interrupt(context: Context, number: number | undefined) {
    const sessionID = number === undefined ? currentSession(context.user) : context.user.sessions[String(number)]
    if (!sessionID) return say(context, number === undefined ? noCurrent() : `没有 #${number}，先发 /list`)
    const target = await drivable(context.user, sessionID)
    if (typeof target === "string") return say(context, target)
    const label = sessionLabel(context.user, sessionID, target)
    const watcher = watchers.get(sessionID)
    if (watcher) watcher.interrupted = true
    const done = await client.sessions.interrupt({ sessionID }).then(
      () => undefined,
      (error: unknown) => errorText(error),
    )
    if (done) return say(context, `${label} 中断失败：${done}`)
    return say(context, watcher || sessionID in (await active()) ? `${label} 已中断` : `${label} 本来就是空闲的`)
  }

  async function status(context: Context) {
    const sessionID = currentSession(context.user)
    if (!sessionID) return say(context, noCurrent())
    const info = await client.sessions.get({ sessionID }).catch(() => undefined)
    if (!info) return say(context, "当前会话已不存在，发 /list 重新选择")
    const label = sessionLabel(context.user, sessionID, info)
    const running = sessionID in (await active())
    const turn = state.sessions[sessionID]?.lastTurn
    const lines = [
      `【${label}】${info.title || "（无标题）"} · ${running ? "运行中" : "空闲"}`,
      turn
        ? [
            `上一轮${turn.interrupted ? "（已中断）" : turn.error ? `（出错：${turn.error}）` : ""}：${statsLine(turn)}`,
            turn.tools > 0
              ? `工具：${Object.entries(turn.toolNames)
                  .map(([name, count]) => `${name}×${count}`)
                  .join("、")}`
              : undefined,
            turn.files.length > 0
              ? `改动：${turn.files.slice(0, 10).join("、")}${turn.files.length > 10 ? " 等" : ""}`
              : undefined,
          ]
            .filter((line) => line !== undefined)
            .join("\n")
        : "还没有通过 remote 跑过一轮",
    ]
    await say(context, lines.join("\n"))
    // Re-issue codes for asks that are still open, e.g. after a code expired or a restart.
    await announcePending(context, sessionID, true)
  }

  async function approve(context: Context, action: string, code: string) {
    const approval = context.user.approvals[code]
    if (!approval) return say(context, `没有审批码 ${code}`)
    if (approval.expires <= now()) {
      delete context.user.approvals[code]
      return say(context, `审批码 ${code} 已过期，发 /status 重新获取`)
    }
    delete context.user.approvals[code]
    if (approval.kind === "question") {
      if (action !== "n") return say(context, `这是一个提问，回复 q${code} 编号 作答，或 n${code} 拒绝`)
      const failed = await client.questions
        .reject({ sessionID: approval.sessionID, requestID: approval.requestID })
        .then(() => undefined, errorText)
      return say(context, failed ? `拒绝失败：${failed}` : `已拒绝提问 ${code}`)
    }
    const reply = action === "y" ? "once" : action === "a" ? "always" : "reject"
    const failed = await client.permissions
      .reply({ sessionID: approval.sessionID, requestID: approval.requestID, reply })
      .then(() => undefined, errorText)
    if (failed) return say(context, `审批失败（可能已在别处处理）：${failed}`)
    return say(
      context,
      reply === "reject" ? `已拒绝 ${code}` : reply === "always" ? `已总是允许 ${code}` : `已允许 ${code}`,
    )
  }

  async function answerQuestion(context: Context, code: string, body: string) {
    const approval = context.user.approvals[code]
    if (!approval || approval.kind !== "question") return say(context, `没有提问 ${code}`)
    if (approval.expires <= now()) {
      delete context.user.approvals[code]
      return say(context, `提问 ${code} 已过期，发 /status 重新获取`)
    }
    const answers = parseAnswers(approval.questions ?? [], body)
    if (typeof answers === "string") return say(context, answers)
    delete context.user.approvals[code]
    const failed = await client.questions
      .reply({ sessionID: approval.sessionID, requestID: approval.requestID, answers })
      .then(() => undefined, errorText)
    return say(context, failed ? `作答失败：${failed}` : `已作答 ${code}`)
  }

  async function subscribe() {
    while (!abort.signal.aborted) {
      const failed = await consume().then(
        () => undefined,
        (error: unknown) => error,
      )
      if (abort.signal.aborted) return
      if (failed) log(`remote: event stream dropped: ${errorText(failed)}`)
      await Bun.sleep(1000)
    }
  }

  async function consume() {
    for await (const event of client.events.subscribe({ signal: abort.signal })) {
      if (event.type === "server.connected") {
        connected.resolve()
        track(resync())
        continue
      }
      if (event.type === "permission.v2.asked") {
        const data = event.data
        notifyAsk(
          data.sessionID,
          data.id,
          () => ({ kind: "permission" }),
          (label, code) => permissionText(label, code, data),
        )
        continue
      }
      if (event.type === "question.v2.asked") {
        const data = event.data
        notifyAsk(
          data.sessionID,
          data.id,
          () => ({ kind: "question", questions: data.questions }),
          (label, code) => questionText(label, code, data.questions),
        )
        continue
      }
      if (
        event.type === "permission.v2.replied" ||
        event.type === "question.v2.replied" ||
        event.type === "question.v2.rejected"
      ) {
        forget(event.data.requestID)
        continue
      }
      const aggregate = event.durable?.aggregateID
      if (aggregate && event.type.startsWith("session.next.") && !state.sessions[aggregate]?.local) {
        sessionState(aggregate).local = true
        void save()
      }
    }
  }

  function notifyAsk(
    sessionID: string,
    requestID: string,
    shape: () => Pick<Approval, "kind" | "questions">,
    render: (label: string, code: string) => string,
  ) {
    const key = state.sessions[sessionID]?.driver
    if (!key) return
    const channel = channels.get(key.slice(0, key.indexOf(":")))
    if (!channel) return
    void serial(key, async () => {
      const user = userState(key)
      if (liveApprovals(user).some((approval) => approval.requestID === requestID)) return
      const code = allocate(user, { ...shape(), sessionID, requestID, expires: now() + ttl })
      const info = await client.sessions.get({ sessionID }).catch(() => undefined)
      await deliver(
        { channel, key, user },
        { kind: "approval", text: render(sessionLabel(user, sessionID, info), code) },
      )
      await save()
    })
  }

  // After (re)connecting, asks raised while the stream was down would otherwise wait forever.
  async function resync() {
    await Promise.all(
      Object.entries(state.sessions).flatMap(([sessionID, session]) => {
        const key = session.driver
        if (!key) return []
        const channel = channels.get(key.slice(0, key.indexOf(":")))
        if (!channel) return []
        return [serial(key, () => announcePending({ channel, key, user: userState(key) }, sessionID, false))]
      }),
    )
  }

  async function announcePending(context: Context, sessionID: string, includeLive: boolean) {
    const [permissions, questions, info] = await Promise.all([
      client.permissions.list({ sessionID }).catch(() => []),
      client.questions.list({ sessionID }).catch(() => []),
      client.sessions.get({ sessionID }).catch(() => undefined),
    ])
    const label = sessionLabel(context.user, sessionID, info)
    const codeFor = (requestID: string, approval: Omit<Approval, "expires" | "sessionID" | "requestID">) => {
      const existing = Object.entries(context.user.approvals).find(
        ([, item]) => item.requestID === requestID && item.expires > now(),
      )
      if (existing) return includeLive ? existing[0] : undefined
      return allocate(context.user, { ...approval, sessionID, requestID, expires: now() + ttl })
    }
    const texts = [
      ...permissions.flatMap((request) => {
        const code = codeFor(request.id, { kind: "permission" })
        return code ? [permissionText(label, code, request)] : []
      }),
      ...questions.flatMap((request) => {
        const code = codeFor(request.id, { kind: "question", questions: request.questions })
        return code ? [questionText(label, code, request.questions)] : []
      }),
    ]
    if (texts.length === 0) return
    for (const text of texts) await deliver(context, { kind: "approval", text })
    await save()
  }

  function forget(requestID: string) {
    Object.values(state.users).forEach((user) => {
      Object.entries(user.approvals).forEach(([code, approval]) => {
        if (approval.requestID === requestID) delete user.approvals[code]
      })
    })
  }

  // Inside the reply window a message goes straight out. Outside it, results are
  // held for the next inbound message and only a short notice is pushed, within
  // the channel's daily budget; approvals may spend the last unit of budget.
  async function deliver(context: Context, message: Message) {
    const capabilities = context.channel.capabilities
    if (windowOpen(capabilities, context.user)) {
      const sent = await send(context, message.text)
      if (sent.ok) return
    }
    if (message.kind === "reply") return
    context.user.pending.push({ text: message.text, at: now() })
    if (!capabilities.push) return
    const reserve = message.kind === "approval" ? 0 : 1
    if (!budgetLeft(capabilities, context.user, reserve)) {
      log(`remote: push budget spent for ${context.key}; holding ${message.kind}`)
      return
    }
    const pushed = await send(context, message.kind === "approval" ? message.text : (message.notice ?? message.text))
    if (!pushed.ok) return
    countPush(context.user)
    if (message.kind === "approval") context.user.pending.pop()
  }

  async function flush(context: Context, explicit: boolean) {
    const user = context.user
    if (user.pending.length === 0) return explicit ? say(context, "没有待取结果") : undefined
    // Hold back the rest when the backlog is long, so one inbound message is not
    // answered with more messages than the channel accepts.
    const limit = context.channel.capabilities.maxLength * 3
    const totals = user.pending.map((_, index) =>
      user.pending.slice(0, index + 1).reduce((size, item) => size + item.text.length, 0),
    )
    const over = totals.findIndex((total) => total > limit)
    const taken = user.pending.slice(0, over === -1 ? user.pending.length : Math.max(over, 1))
    user.pending = user.pending.slice(taken.length)
    const sent = await send(context, ["待取结果：", ...taken.map((item) => item.text)].join("\n\n"))
    if (!sent.ok) {
      user.pending = [...taken, ...user.pending]
      return
    }
    if (user.pending.length > 0) await say(context, `还有 ${user.pending.length} 条待取结果，发 /r 继续`)
  }

  function say(context: Context, text: string) {
    return deliver(context, { kind: "reply", text })
  }

  async function send(context: Context, text: string): Promise<SendResult> {
    const result = await context.channel
      .send(userOf(context.key), text, replyContext.get(context.key))
      .catch((error: unknown) => ({ ok: false, sent: 0, error: errorText(error) }))
    context.user.replies += result.sent
    if (!result.ok) log(`remote: send to ${context.key} failed: ${result.error ?? "unknown"}`)
    return result
  }

  function windowOpen(capabilities: Capabilities, user: UserState) {
    if (capabilities.replyWindowMs === undefined) return true
    if (now() - user.lastInboundAt >= capabilities.replyWindowMs) return false
    return capabilities.repliesPerInbound === undefined || user.replies < capabilities.repliesPerInbound
  }

  function budgetLeft(capabilities: Capabilities, user: UserState, reserve: number) {
    if (capabilities.pushBudgetPerDay === undefined) return true
    const used = user.pushes.day === day(now()) ? user.pushes.count : 0
    return capabilities.pushBudgetPerDay - used > reserve
  }

  function countPush(user: UserState) {
    const today = day(now())
    user.pushes = { day: today, count: (user.pushes.day === today ? user.pushes.count : 0) + 1 }
  }

  async function listSessions() {
    const pages = await Promise.all(
      Object.values(projects).map((directory) =>
        client.sessions
          .list({ directory, limit: 20, order: "desc" })
          .then((page) => page.data)
          .catch(() => []),
      ),
    )
    const seen = new Set<string>()
    return pages
      .flat()
      .filter((session) => !session.parentID && session.time.archived === undefined)
      .filter((session) => projectOf(session.location.directory) !== undefined)
      .filter((session) => !seen.has(session.id) && seen.add(session.id))
  }

  async function active() {
    return client.sessions.active().catch(() => ({}) as Record<string, { type: "running" }>)
  }

  async function drivable(user: UserState, sessionID: string): Promise<SessionInfo | string> {
    const info = await client.sessions.get({ sessionID }).catch(() => undefined)
    const number = numberOf(user, sessionID)
    if (!info) return `#${number} 已不存在`
    if (projectOf(info.location.directory) === undefined)
      return `#${number} 不在允许遥控的项目里（配置 remote.projects），不能驱动`
    if (!state.sessions[sessionID]?.local)
      return `#${number} 不在 miao remote 的服务里（可能开在单独的 TUI 里），只能查看。要遥控它，请在桌面用 ${options.attach ?? "miao attach"} 打开它并发一条消息`
    return info
  }

  function sessionLabel(user: UserState, sessionID: string, info: SessionInfo | undefined) {
    const project = info ? projectOf(info.location.directory) : undefined
    return `#${numberOf(user, sessionID)}${project ? ` ${project}` : ""}`
  }

  function projectOf(directory: string) {
    return Object.entries(projects).find(
      ([, root]) => directory === root || directory.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
    )?.[0]
  }

  function projectList() {
    const entries = Object.entries(projects)
    if (entries.length === 0) return "还没有可遥控的项目，请在配置的 remote.projects 里添加"
    return [
      "可遥控的项目：",
      ...entries.map(([alias, directory]) => `${alias} → ${directory.replace(os.homedir(), "~")}`),
    ].join("\n")
  }

  function userState(key: string) {
    const existing = state.users[key]
    if (existing) return existing
    const created: UserState = {
      next: 1,
      sessions: {},
      approvals: {},
      nextCode: 1,
      pending: [],
      pushes: { day: "", count: 0 },
      lastInboundAt: 0,
      replies: 0,
    }
    state.users[key] = created
    return created
  }

  function sessionState(sessionID: string) {
    const existing = state.sessions[sessionID]
    if (existing) return existing
    const created: SessionState = { local: false }
    state.sessions[sessionID] = created
    return created
  }

  function numberOf(user: UserState, sessionID: string) {
    const existing = Object.entries(user.sessions).find(([, id]) => id === sessionID)
    if (existing) return Number(existing[0])
    const number = user.next
    user.next = number + 1
    user.sessions[String(number)] = sessionID
    return number
  }

  function currentSession(user: UserState) {
    return user.current === undefined ? undefined : user.sessions[String(user.current)]
  }

  function liveApprovals(user: UserState) {
    return Object.values(user.approvals).filter((approval) => approval.expires > now())
  }

  function allocate(user: UserState, approval: Approval) {
    const taken = (code: number) => (user.approvals[String(code)]?.expires ?? 0) > now()
    const code = Array.from({ length: 99 }, (_, index) => ((user.nextCode - 1 + index) % 99) + 1).find(
      (candidate) => !taken(candidate),
    )
    // All 99 codes live at once is not a real situation; reuse the oldest slot rather than fail.
    const chosen = code ?? user.nextCode
    user.nextCode = (chosen % 99) + 1
    user.approvals[String(chosen)] = approval
    return String(chosen)
  }

  function userOf(key: string) {
    return key.slice(key.indexOf(":") + 1)
  }
}

export function parseAnswers(questions: ReadonlyArray<Question>, body: string): string[][] | string {
  const parts = questions.length === 1 ? [body] : body.split(/[;；]/)
  if (parts.length !== questions.length) return `有 ${questions.length} 个问题，请用 ; 分开每个问题的回答`
  const answers = questions.map((question, index) => {
    const part = parts[index].trim()
    const tokens = part.split(/[,，\s]+/).filter(Boolean)
    const numeric = tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token))
    if (!numeric) return question.custom === false ? `第 ${index + 1} 个问题只能选编号` : [part]
    const picked = tokens.map(Number)
    if (picked.some((number) => number < 1 || number > question.options.length))
      return `第 ${index + 1} 个问题的编号要在 1-${question.options.length} 之间`
    if (picked.length > 1 && !question.multiSelect) return `第 ${index + 1} 个问题只能选一个`
    return picked.map((number) => question.options[number - 1].label)
  })
  const invalid = answers.find((answer) => typeof answer === "string")
  if (typeof invalid === "string") return invalid
  return answers.filter((answer): answer is string[] => typeof answer !== "string")
}

function permissionText(
  label: string,
  code: string,
  request: { readonly action: string; readonly resources: ReadonlyArray<string>; readonly metadata?: unknown },
) {
  const command =
    typeof field(request.metadata, "command") === "string" ? String(field(request.metadata, "command")) : undefined
  const detail = truncate(command ?? request.resources.join("\n"), 600)
  return [
    `【${label}】请求执行 ${request.action}：`,
    ...detail.split("\n").map((line) => `  ${line}`),
    `回复 y${code} 允许一次 · a${code} 总是允许 · n${code} 拒绝`,
  ].join("\n")
}

function questionText(label: string, code: string, questions: ReadonlyArray<Question>) {
  return [
    `【${label}】提问：`,
    ...questions.flatMap((question, index) => [
      `${questions.length > 1 ? `${index + 1}) ` : ""}${question.question}${question.multiSelect ? "（可多选）" : ""}`,
      ...question.options.map(
        (option, choice) => `  ${choice + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      ),
    ]),
    `回复 q${code} 编号 作答${questions.length > 1 ? "（多个问题用 ; 分开，如 q" + code + " 1;2）" : ""}，也可直接写答案 · n${code} 拒绝`,
  ].join("\n")
}

function statsLine(turn: Turn) {
  return [
    `工具 ${turn.tools} 次`,
    `改动 ${turn.files.length} 个文件`,
    `用时 ${duration(turn.durationMs)}`,
    `花费 ${turn.cost.toFixed(4)}`,
  ].join(" · ")
}

function help() {
  return [
    "可用命令：",
    "/list 列出会话 · /use N 切换当前会话",
    "/new <项目> [内容] 新建会话 · /projects 项目列表",
    "#N 消息 发给 #N（不切换）· #N /stop 中断 #N",
    "/stop 中断当前会话 · /queue 消息 排队到这一轮之后",
    "/r 取回待取结果 · /status 当前会话最近一轮",
    "直接发文字 = 发给当前会话（运行中会插入当前这一轮）",
    "审批：y编号 允许一次 · a编号 总是允许 · n编号 拒绝；提问：q编号 选项",
  ].join("\n")
}

function noCurrent() {
  return "还没有当前会话：发 /list 选一个，或 /new <项目> 新建"
}

function parseState(input: unknown): State {
  const value = typeof input === "object" && input !== null ? (input as Partial<State>) : {}
  return {
    version: 1,
    users: value.users ?? {},
    sessions: value.sessions ?? {},
  }
}

function parseNumber(text: string) {
  const match = /^#?(\d+)$/.exec(text.trim())
  return match ? Number(match[1]) : undefined
}

function truncate(text: string, limit: number) {
  const characters = [...text]
  if (characters.length <= limit) return text
  return characters.slice(0, Math.max(limit - 8, 1)).join("") + "…（已截断）"
}

function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

function ago(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

function day(time: number) {
  return new Date(time).toLocaleDateString("sv-SE")
}

function expandHome(directory: string) {
  if (directory === "~") return os.homedir()
  if (directory.startsWith("~/")) return path.join(os.homedir(), directory.slice(2))
  return path.resolve(directory)
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = field(error, "message")
  if (typeof message === "string" && message) return message
  const tag = field(error, "_tag")
  return typeof tag === "string" ? tag : String(error)
}
