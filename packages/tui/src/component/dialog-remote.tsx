// /remote: manage the `miao remote` daemon's IM connectors from the TUI. The
// dialog talks to the daemon's control routes on 127.0.0.1:<remote.port>, which
// may be a different server than the one this TUI is attached to. It renders
// login steps (QR codes as half-block characters, inputs, pairing codes) and
// never starts, installs, or stops anything by itself.
import { RGBA, TextAttributes } from "@opentui/core"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Flag } from "@miao/core/flag/flag"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"

export const DefaultPort = 4097

export type LoginStep =
  | { readonly type: "qr"; readonly content: string; readonly hint?: string }
  | { readonly type: "code"; readonly prompt: string }
  | {
      readonly type: "form"
      readonly title: string
      readonly fields: ReadonlyArray<{
        readonly key: string
        readonly label: string
        readonly secret?: boolean
        readonly optional?: boolean
        readonly placeholder?: string
      }>
    }
  | { readonly type: "open"; readonly url: string; readonly hint?: string }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "pair"
      readonly code: string
      readonly expiresAt: number
      readonly link?: string
      readonly hint: string
    }
  | {
      readonly type: "done"
      readonly connector: string
      readonly account: { readonly id: string; readonly label: string }
      readonly message?: string
    }
  | { readonly type: "error"; readonly message: string }

export type AccountStatus = {
  readonly connector: string
  readonly account: string
  readonly label: string
  readonly state: "connected" | "connecting" | "retrying" | "needs-login" | "unpaired" | "offline" | "error"
  readonly owner?: string
  readonly error?: string
  readonly pushesToday: number
  readonly pushBudget?: number
  readonly pending: number
  readonly approvals: number
}

export type ConnectorStatus = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly pairing: boolean
  readonly notice?: string
  readonly accounts: ReadonlyArray<AccountStatus>
}

export type DaemonStatus = {
  readonly pid: number
  readonly port: number
  readonly version: string
  readonly connectors: ReadonlyArray<ConnectorStatus>
}

/** The daemon's control routes, as the dialog uses them. */
export type RemoteApi = {
  /** Undefined when no daemon answers on the port. */
  readonly status: () => Promise<DaemonStatus | undefined>
  readonly login: (connector: string) => Promise<string>
  readonly events: (flow: string, signal: AbortSignal) => AsyncIterable<LoginStep>
  readonly input: (flow: string, value: string | Readonly<Record<string, string>>) => Promise<void>
  readonly cancel: (flow: string) => Promise<void>
  readonly remove: (connector: string, account: string) => Promise<void>
  readonly pair: (connector: string, account: string) => Promise<LoginStep>
  readonly test: (connector: string, account: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
}

export type RemoteEnvironment = {
  readonly api: RemoteApi
  readonly port: number
  /** This TUI is attached to the daemon's server, so its sessions can be driven from IM. */
  readonly attached: boolean
  readonly sessionID?: string
  readonly uid: number
}

/** Control routes over the generated SDK; any failure to reach the daemon reads as "not running". */
export function createRemoteApi(input: {
  url: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}): RemoteApi {
  const client = createOpencodeClient({ baseUrl: input.url, headers: input.headers, fetch: input.fetch }).v2.remote
  const fail = (error: unknown): never => {
    const message =
      typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
    throw new Error(message)
  }
  return {
    status: () =>
      client.get({ signal: AbortSignal.timeout(2000) }).then(
        (result) => (result.data ? (result.data as DaemonStatus) : undefined),
        () => undefined,
      ),
    login: (connector) =>
      client.login.start({ connector }, { throwOnError: true }).then((result) => result.data.flow, fail),
    events: (flow, signal) => ({
      [Symbol.asyncIterator]: async function* () {
        // A finished flow ends the stream; do not reconnect and replay it.
        const result = await client.login.events({ flow }, { signal, sseMaxRetryAttempts: 1 })
        // The SSE client yields each event's parsed data; the generated type models the envelope.
        for await (const step of result.stream) yield step as unknown as LoginStep
      },
    }),
    input: (flow, value) =>
      client.login.input({ flow, remoteLoginAnswer: { value } }, { throwOnError: true }).then(() => undefined, fail),
    cancel: (flow) => client.login.cancel({ flow }).then(() => undefined),
    remove: (connector, account) =>
      client.account.remove({ connector, account }, { throwOnError: true }).then(() => undefined, fail),
    pair: (connector, account) =>
      client.account
        .pair({ connector, account }, { throwOnError: true })
        .then((result) => result.data as LoginStep, fail),
    test: (connector, account) =>
      client.account.test({ connector, account }, { throwOnError: true }).then((result) => result.data, fail),
  }
}

/** /remote, wired to this TUI's config, server, and route. */
export function DialogRemote() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const port = sync.data.config.remote?.port ?? DefaultPort
  const url = `http://127.0.0.1:${port}`
  const password = Flag.MIAO_SERVER_PASSWORD
  const headers = password
    ? {
        Authorization: `Basic ${Buffer.from(`${Flag.MIAO_SERVER_USERNAME ?? "miao"}:${password}`).toString("base64")}`,
      }
    : undefined
  return (
    <DialogRemoteView
      environment={{
        api: createRemoteApi({ url, headers }),
        port,
        attached: sameServer(sdk.url, url),
        sessionID: route.data.type === "session" ? route.data.sessionID : undefined,
        uid: process.getuid?.() ?? 0,
      }}
    />
  )
}

export function DialogRemoteView(props: { environment: RemoteEnvironment }) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const environment = props.environment
  const [status, setStatus] = createSignal<DaemonStatus | undefined | "loading">("loading")
  // Polling replaces the options only when something changed, so the highlighted row stays put.
  const refresh = () =>
    environment.api.status().then((value) => {
      const current = status()
      if (current === "loading" || JSON.stringify(current) !== JSON.stringify(value)) setStatus(value)
    })
  onMount(() => void refresh())
  const timer = setInterval(() => void refresh(), 3000)
  onCleanup(() => clearInterval(timer))
  const address = `127.0.0.1:${environment.port}`

  const options = createMemo((): DialogSelectOption<string>[] => {
    const current = status()
    if (current === "loading")
      return [{ value: "daemon", title: "守护进程", description: "◌ 正在检查…", category: "守护进程" }]
    if (!current)
      return [
        {
          value: "daemon",
          title: "守护进程",
          description: `○ 未运行（${address}）`,
          category: "守护进程",
          onSelect: () => void refresh(),
        },
        {
          value: "foreground",
          title: "前台启动",
          description: "在新的终端标签页运行 miao remote",
          category: "守护进程",
          onSelect: () => show(dialog, "前台启动", foregroundHelp(environment.port)),
        },
        {
          value: "install",
          title: "安装常驻（launchd）",
          description: "显示需要你确认执行的命令",
          category: "守护进程",
          onSelect: () => show(dialog, "安装常驻", installHelp(environment.uid)),
        },
        {
          value: "login",
          title: "接入 IM",
          description: "守护进程没运行时，在终端登录",
          category: "连接器",
          onSelect: () => show(dialog, "接入 IM", loginHelp()),
        },
      ]
    return [
      {
        value: "daemon",
        title: "守护进程",
        description: `● 运行中 ${address}（pid ${current.pid}）`,
        category: "守护进程",
        onSelect: () => void refresh(),
      },
      ...current.connectors.flatMap((connector): DialogSelectOption<string>[] =>
        connector.accounts.length === 0
          ? [
              {
                value: `login:${connector.id}`,
                title: connector.name,
                description: "○ 未接入",
                footer: "回车 接入",
                category: "连接器",
                onSelect: () => login(connector),
              },
            ]
          : connector.accounts.map((account) => ({
              value: `account:${connector.id}/${account.account}`,
              title: `${connector.name} ${account.account}`,
              description: stateText(account),
              footer: usageText(account),
              category: "连接器",
              onSelect: () => manage(connector, account),
            })),
      ),
      ...(environment.attached
        ? []
        : [
            {
              value: "single-writer",
              title: "这里的会话在手机上只读",
              description: "在守护进程里打开当前会话",
              category: "当前 TUI",
              onSelect: () => show(dialog, "在守护进程里打开当前会话", attachHelp(environment)),
            },
          ]),
    ]
  })

  const reopen = () => dialog.replace(() => <DialogRemoteView environment={environment} />)

  function login(connector: ConnectorStatus) {
    void runLogin({ dialog, toast, environment, connector, back: reopen })
  }

  function manage(connector: ConnectorStatus, account: AccountStatus) {
    const run = (work: () => Promise<string>) =>
      work().then(
        (message) => toast.show({ message, variant: "success" }),
        (error: unknown) => toast.show({ message: errorText(error), variant: "error" }),
      )
    dialog.replace(() => (
      <DialogSelect
        title={`${connector.name} ${account.account}`}
        options={[
          {
            value: "test",
            title: "发送测试消息",
            description: account.owner ? `发给主人 ${account.owner}` : "还没有主人",
            onSelect: () =>
              void run(async () => {
                const result = await environment.api.test(connector.id, account.account)
                if (!result.ok) throw new Error(result.error ?? "发送失败")
                return "测试消息已发送"
              }).then(reopen),
          },
          ...(connector.pairing
            ? [
                {
                  value: "pair",
                  title: "重新配对",
                  description: "生成新的一次性配对码，第一个发送它的人成为主人",
                  onSelect: () =>
                    void environment.api.pair(connector.id, account.account).then(
                      (step) => dialog.replace(() => <LoginStepView step={step} title={`配对 ${connector.name}`} />),
                      (error: unknown) => toast.show({ message: errorText(error), variant: "error" }),
                    ),
                },
              ]
            : []),
          {
            value: "login",
            title: "重新登录",
            description: account.state === "needs-login" ? "登录已失效，需要重新扫码" : "用新的扫码或凭证替换当前登录",
            onSelect: () => login(connector),
          },
          {
            value: "remove",
            title: "断开",
            description: "停止这个账号并删除凭证",
            onSelect: () =>
              void DialogConfirm.show(dialog, "断开", `断开 ${connector.name} ${account.account} 并删除凭证？`).then(
                (confirmed) =>
                  confirmed
                    ? run(() => environment.api.remove(connector.id, account.account).then(() => "已断开")).then(reopen)
                    : reopen(),
              ),
          },
        ]}
      />
    ))
  }

  return (
    <DialogSelect
      title="远程遥控"
      options={options()}
      footer={<text fg={theme.textMuted}>手机上发 /help 查看用法 · 状态每 3 秒刷新</text>}
    />
  )
}

/** Runs one login flow: shows each step, asks for code and form input, and returns to the list when done. */
export async function runLogin(input: {
  readonly dialog: DialogContext
  readonly toast: ReturnType<typeof useToast>
  readonly environment: RemoteEnvironment
  readonly connector: ConnectorStatus
  readonly back: () => void
}) {
  const api = input.environment.api
  const flow = await api.login(input.connector.id).catch((error: unknown) => {
    input.toast.show({ message: errorText(error), variant: "error" })
    return undefined
  })
  if (!flow) return
  const abort = new AbortController()
  const [step, setStep] = createSignal<LoginStep | undefined>()
  const state = { finished: false, handoff: false }
  const close = () => {
    // Replacing the view with an input prompt is not closing the login.
    if (state.handoff) {
      state.handoff = false
      return
    }
    if (!state.finished) void api.cancel(flow).catch(() => undefined)
    state.finished = true
    abort.abort()
  }
  const show = () =>
    input.dialog.replace(
      () => <LoginStepView step={step()} title={`接入 ${input.connector.name}`} notice={input.connector.notice} />,
      close,
    )
  show()
  for await (const next of api.events(flow, abort.signal)) {
    if (state.finished) return
    setStep(next)
    if (next.type === "done") {
      state.finished = true
      input.toast.show({
        message: `已接入${input.connector.name}（${next.account.id}）${next.message ? `：${next.message}` : ""}`,
        variant: "success",
      })
      input.back()
      return
    }
    if (next.type === "error") state.finished = true
    if (next.type !== "code" && next.type !== "form") continue
    const answer = await ask(input.dialog, next, state)
    if (answer === undefined) {
      state.finished = true
      void api.cancel(flow).catch(() => undefined)
      abort.abort()
      return
    }
    await api
      .input(flow, answer)
      .catch((error: unknown) => input.toast.show({ message: errorText(error), variant: "error" }))
    show()
  }
}

async function ask(
  dialog: DialogContext,
  step: Extract<LoginStep, { type: "code" | "form" }>,
  state: { handoff: boolean },
): Promise<string | Record<string, string> | undefined> {
  state.handoff = true
  if (step.type === "code") {
    const value = await DialogPrompt.show(dialog, step.prompt, { placeholder: "输入手机上显示的数字" })
    return value === null ? undefined : value.trim()
  }
  const values: Record<string, string> = {}
  for (const field of step.fields) {
    const value = await DialogPrompt.show(dialog, `${step.title} · ${field.label}`, {
      placeholder: field.placeholder ?? (field.optional ? "可留空" : field.label),
      description: field.secret ? () => <text>输入内容会显示在屏幕上，请注意身边的人</text> : undefined,
    })
    if (value === null) return undefined
    values[field.key] = value.trim()
  }
  return values
}

/** One login step: QR code, pairing code, progress, or error. */
export function LoginStepView(props: { step: LoginStep | undefined; title: string; notice?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  onMount(() => dialog.setSize("large"))
  useBindings(() => ({
    enabled: props.step?.type === "error",
    bindings: [{ key: "return", desc: "Close", group: "Dialog", cmd: () => dialog.clear() }],
  }))
  const qr = createMemo(() => {
    const step = props.step
    if (step?.type === "qr") return renderUnicodeCompact(step.content, { border: 1 }).split("\n")
    if (step?.type === "pair" && step.link) return renderUnicodeCompact(step.link, { border: 1 }).split("\n")
    return []
  })
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={props.notice && props.step?.type === "qr"}>
        <text fg={theme.warning}>{props.notice}</text>
      </Show>
      <Show when={!props.step}>
        <text fg={theme.textMuted}>正在开始登录…</text>
      </Show>
      <Show when={props.step?.type === "pair" ? props.step : undefined}>
        {(pair) => (
          <box gap={1}>
            <text fg={theme.text}>
              配对码 <span style={{ fg: theme.primary, attributes: TextAttributes.BOLD }}>{pair().code}</span>
            </text>
            <text fg={theme.textMuted}>{pair().hint}</text>
          </box>
        )}
      </Show>
      <Show when={qr().length > 0}>
        {/* Light modules on dark: the half-block QR scans regardless of the theme. */}
        <box>
          <For each={qr()}>
            {(line) => (
              <text fg={QrLight} bg={QrDark}>
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.step?.type === "qr" ? props.step : undefined}>
        {(step) => (
          <box gap={1}>
            <Show when={step().hint}>
              <text fg={theme.text}>{step().hint}</text>
            </Show>
            <text fg={theme.textMuted}>扫不了时用手机打开：{step().content}</text>
          </box>
        )}
      </Show>
      <Show when={props.step?.type === "open" ? props.step : undefined}>
        {(step) => (
          <text fg={theme.text}>
            {step().hint ?? "在浏览器里打开"}：{step().url}
          </text>
        )}
      </Show>
      <Show when={props.step?.type === "progress" ? props.step : undefined}>
        {(step) => <text fg={theme.textMuted}>{step().message}</text>}
      </Show>
      <Show when={props.step?.type === "error" ? props.step : undefined}>
        {(step) => (
          <box gap={1}>
            <text fg={theme.error}>{step().message}</text>
            <text fg={theme.textMuted}>回车关闭，重新打开 /remote 再试</text>
          </box>
        )}
      </Show>
    </box>
  )
}

const QrLight = RGBA.fromHex("#ffffff")
const QrDark = RGBA.fromHex("#000000")

export function stateText(account: AccountStatus) {
  const state = {
    connected: "● 已连接",
    connecting: "◌ 连接中",
    retrying: "◌ 重连中",
    "needs-login": "✕ 需要重新登录",
    unpaired: "○ 等待配对",
    offline: "○ 未运行",
    error: "✕ 出错",
  }[account.state]
  return account.error && account.state !== "connected" ? `${state}：${account.error}` : state
}

export function usageText(account: AccountStatus) {
  return `推送 ${account.pushesToday}${account.pushBudget === undefined ? "" : `/${account.pushBudget}`} · 待取 ${account.pending}`
}

export function installHelp(uid: number) {
  return [
    "miao 不会在 TUI 里静默拉起后台进程。请在终端里自己执行：",
    "",
    "  miao remote install",
    `  launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/dev.mtty.miao.remote.plist`,
    "",
    "第一条写入 launchd plist，第二条加载并启动它。之后回到 /remote 查看状态。",
  ].join("\n")
}

export function foregroundHelp(port: number) {
  return [
    "在新的终端标签页运行：",
    "",
    "  miao remote",
    "",
    `它会在 127.0.0.1:${port} 起服务并连接已登录的 IM。关闭那个标签页即停止。`,
  ].join("\n")
}

export function loginHelp() {
  return [
    "守护进程没运行时，可以直接在终端登录（无需守护进程）：",
    "",
    "  miao remote login wechat",
    "  miao remote login qq",
    "",
    "然后启动守护进程，就能在这里管理已接入的账号。",
  ].join("\n")
}

export function attachHelp(environment: Pick<RemoteEnvironment, "port" | "sessionID">) {
  const command = `miao attach http://127.0.0.1:${environment.port}${environment.sessionID ? ` --session ${environment.sessionID}` : ""}`
  return [
    "这个 TUI 没有连到守护进程：会话执行只在本进程里，手机上只能查看，不能驱动。",
    "",
    "退出当前 TUI（确保这个会话没有在运行），然后在终端执行：",
    "",
    `  ${command}`,
    "",
    "之后在手机上就能驱动这个会话。",
  ].join("\n")
}

function show(dialog: DialogContext, title: string, message: string) {
  void DialogAlert.show(dialog, title, message)
}

function sameServer(a: string, b: string) {
  const parse = (value: string) => {
    const url = URL.parse(value)
    if (!url) return value
    const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname
    return `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`
  }
  return parse(a) === parse(b)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
