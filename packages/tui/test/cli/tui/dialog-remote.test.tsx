/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type {
  ConnectorStatus,
  DaemonPlan,
  DaemonResult,
  DaemonStatus,
  LoginStep,
  RemoteApi,
  RemoteEnvironment,
  RemoteLocal,
} from "../../../src/component/dialog-remote"
import type { DeviceApi } from "../../../src/component/dialog-devices"
import type { ClipboardService } from "../../../src/context/clipboard"
import type { RemoteAccess } from "@miao/schema/remote-access"
import { createHash } from "node:crypto"

const wechat = {
  id: "wechat",
  name: "微信",
  pairing: false,
  accounts: [
    {
      connector: "wechat",
      account: "bot@im.bot",
      label: "微信 ClawBot",
      state: "connected" as const,
      owner: "owne…wechat",
      pushesToday: 1,
      pushBudget: 4,
      pending: 2,
      approvals: 0,
    },
  ],
}
const qq = {
  id: "qq",
  name: "QQ 机器人",
  pairing: false,
  notice: "提示：新建一个专用机器人",
  accounts: [],
}
const telegram = { id: "telegram", name: "Telegram", pairing: true, accounts: [] }

/** An in-memory daemon: records calls and lets the test push login steps and change its status. */
function daemon(initial: DaemonStatus | undefined) {
  const state = { status: initial }
  const calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> = []
  const steps: LoginStep[] = []
  const waiters = new Set<() => void>()
  const push = (...next: LoginStep[]) => {
    steps.push(...next)
    waiters.forEach((wake) => wake())
  }
  const api: RemoteApi = {
    status: async () => state.status,
    login: async (connector) => {
      calls.push({ name: "login", args: [connector] })
      return "flow-1"
    },
    events: (_flow, signal) => ({
      [Symbol.asyncIterator]: async function* () {
        const cursor = { index: 0 }
        while (!signal.aborted) {
          while (cursor.index < steps.length) yield steps[cursor.index++]
          await new Promise<void>((resolve) => {
            waiters.add(resolve)
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
      },
    }),
    input: async (flow, value) => void calls.push({ name: "input", args: [flow, value] }),
    cancel: async (flow) => void calls.push({ name: "cancel", args: [flow] }),
    remove: async (connector, account) => void calls.push({ name: "remove", args: [connector, account] }),
    pair: async () => ({ type: "pair", code: "654321", expiresAt: Date.now() + 600_000, hint: "发送配对码" }),
    test: async (connector, account) => {
      calls.push({ name: "test", args: [connector, account] })
      return { ok: true }
    },
  }
  return { api, calls, push, set: (next: DaemonStatus | undefined) => void (state.status = next) }
}

async function mount(root: string, environment: RemoteEnvironment, clipboard?: ClipboardService) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogRemoteView },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { ClipboardProvider },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-remote"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
    import("../../../src/context/clipboard"),
  ])

  function Opener() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogRemoteView environment={environment} />))
    return <text>Conversation</text>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, resolvedConfig))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <ClipboardProvider value={clipboard}>
                    <DialogProvider>
                      <Opener />
                      <Toast />
                    </DialogProvider>
                  </ClipboardProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 120, height: 90 })
  const until = async (ready: (frame: string) => boolean, timeout = 3000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (ready(frame)) return frame
      await Bun.sleep(20)
    }
    throw new Error(`frame never matched:\n${app.captureCharFrame()}`)
  }
  // The first row starts highlighted; move down to the wanted row and confirm it.
  const select = async (row: number) => {
    await Bun.sleep(30)
    for (const _ of Array.from({ length: row })) {
      await app.mockInput.pressArrow("down")
      await app.renderOnce()
    }
    await app.mockInput.pressEnter()
  }
  return { app, until, select, cleanup: () => app.renderer.destroy() }
}

const environment = (api: RemoteApi, extra: Partial<RemoteEnvironment> = {}): RemoteEnvironment => ({
  api,
  port: 4097,
  attached: false,
  sessionID: "ses_current",
  uid: 501,
  platform: "darwin",
  waitMs: 20,
  ...extra,
})

test("without a daemon it offers foreground and launchd instructions and never runs them", async () => {
  await using tmp = await tmpdir()
  const remote = daemon(undefined)
  const view = await mount(tmp.path, environment(remote.api))
  try {
    const frame = await view.until((value) => value.includes("○ 未运行（127.0.0.1:4097）"))
    expect(frame).toContain("前台启动")
    expect(frame).toContain("安装常驻（launchd）")
    await view.select(2)
    const help = await view.until((value) => value.includes("launchctl bootstrap"))
    expect(help).toContain("miao remote install")
    expect(help).toContain("launchctl bootstrap gui/501 ~/Library/LaunchAgents/")
    expect(help).toContain("dev.mtty.miao.remote.plist")
    expect(remote.calls).toEqual([])
  } finally {
    view.cleanup()
  }
})

test("lists connectors with state and usage, and logs in to QQ by rendering the QR code", async () => {
  await using tmp = await tmpdir()
  const remote = daemon({ pid: 42, port: 4097, version: "0.0.33", connectors: [wechat, qq] })
  const view = await mount(tmp.path, environment(remote.api))
  try {
    const frame = await view.until((value) => value.includes("● 运行中 127.0.0.1:4097（pid 42）"))
    expect(frame).toContain("微信 bot@im.bot")
    expect(frame).toContain("● 已连接")
    expect(frame).toContain("推送 1/4 · 待取 2")
    expect(frame).toContain("○ 未接入")
    expect(frame).toContain("这里的会话在手机上只读")

    // Typing filters the list; the only match is the QQ row.
    await Bun.sleep(50)
    await view.app.mockInput.typeText("QQ")
    await view.until((value) => !value.includes("微信 bot@im.bot"))
    await view.app.mockInput.pressEnter()
    await view.until(() => remote.calls.some((call) => call.name === "login"))
    remote.push({
      type: "qr",
      content: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=t1&source=miao&_wv=2",
      hint: "用手机 QQ 扫码",
    })
    const qr = await view.until((value) => value.includes("扫不了时用手机打开"))
    expect(qr).toContain("接入 QQ 机器人")
    expect(qr).toContain("提示：新建一个专用机器人")
    expect(qr).toContain("用手机 QQ 扫码")
    expect(qr).toMatch(/[▀▄█]{8}/)

    remote.push({ type: "done", connector: "qq", account: { id: "102000001", label: "QQ 机器人" } })
    const back = await view.until((value) => value.includes("已接入QQ 机器人（102000001）"))
    expect(back).toContain("远程遥控")
    expect(remote.calls.map((call) => call.name)).toEqual(["login"])
  } finally {
    view.cleanup()
  }
})

test("a token login asks in an input box, then shows the pairing code", async () => {
  await using tmp = await tmpdir()
  const remote = daemon({ pid: 42, port: 4097, version: "0.0.33", connectors: [telegram] })
  const view = await mount(tmp.path, environment(remote.api, { attached: true }))
  try {
    const frame = await view.until((value) => value.includes("Telegram"))
    expect(frame).not.toContain("这里的会话在手机上只读")
    await view.select(1)
    await view.until(() => remote.calls.some((call) => call.name === "login"))
    remote.push({ type: "form", title: "Telegram bot", fields: [{ key: "token", label: "Bot token", secret: true }] })
    await view.until((value) => value.includes("Telegram bot · Bot token"))
    await view.app.mockInput.typeText("123:abc")
    await view.app.mockInput.pressEnter()
    await view.until(() => remote.calls.some((call) => call.name === "input"))
    expect(remote.calls.find((call) => call.name === "input")?.args).toEqual(["flow-1", { token: "123:abc" }])

    remote.push({
      type: "pair",
      code: "123456",
      expiresAt: Date.now() + 600_000,
      link: "https://t.me/bot?start=123456",
      hint: "发送这 6 位数字",
    })
    const pair = await view.until((value) => value.includes("配对码 123456"))
    expect(pair).toContain("发送这 6 位数字")
    expect(pair).toMatch(/[▀▄█]{8}/)
  } finally {
    view.cleanup()
  }
})

test("closing the dialog during a login cancels the flow", async () => {
  await using tmp = await tmpdir()
  const remote = daemon({ pid: 42, port: 4097, version: "0.0.33", connectors: [qq] })
  const view = await mount(tmp.path, environment(remote.api))
  try {
    await view.until((value) => value.includes("QQ 机器人"))
    await view.select(1)
    remote.push({ type: "qr", content: "https://q.qq.com/x" })
    await view.until((value) => value.includes("扫不了时用手机打开"))
    await view.app.mockInput.pressEscape()
    await view.until(() => remote.calls.some((call) => call.name === "cancel"))
    expect(remote.calls.find((call) => call.name === "cancel")?.args).toEqual(["flow-1"])
  } finally {
    view.cleanup()
  }
})

test("an account can be tested, and the single-writer hint shows how to reattach this session", async () => {
  await using tmp = await tmpdir()
  const remote = daemon({ pid: 42, port: 4097, version: "0.0.33", connectors: [wechat] })
  const view = await mount(tmp.path, environment(remote.api))
  try {
    await view.until((value) => value.includes("微信 bot@im.bot"))
    await view.select(1)
    const actions = await view.until((value) => value.includes("发送测试消息"))
    expect(actions).toContain("重新登录")
    expect(actions).toContain("断开")
    expect(actions).not.toContain("重新配对")
    // The first action is highlighted.
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("测试消息已发送"))
    expect(remote.calls).toContainEqual({ name: "test", args: ["wechat", "bot@im.bot"] })

    await view.until((value) => value.includes("这里的会话在手机上只读"))
    // Rows: daemon, the WeChat account, then the single-writer hint.
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    const help = await view.until((value) => value.includes("miao attach"))
    expect(help).toContain("miao attach http://127.0.0.1:4097")
    expect(help).toContain("--session")
    expect(help).toContain("ses_current")
  } finally {
    view.cleanup()
  }
})

test("the SDK-backed api reads status, follows login steps over SSE, and treats 404 as no daemon", async () => {
  const { createRemoteApi } = await import("../../../src/component/dialog-remote")
  const inputs: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/remote")
        return Response.json({ pid: 7, port: 4097, version: "0.0.33", startedAt: 0, connectors: [qq] })
      if (url.pathname === "/api/remote/login/qq") return Response.json({ flow: "flow-9" })
      if (url.pathname === "/api/remote/login/flow-9/event")
        return new Response(
          [
            `data: ${JSON.stringify({ type: "qr", content: "https://q.qq.com/x" })}\n\n`,
            `data: ${JSON.stringify({ type: "done", connector: "qq", account: { id: "1", label: "QQ" } })}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname === "/api/remote/login/flow-9/input") {
        inputs.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return Response.json({ _tag: "RemoteNotFoundError", message: "not remote" }, { status: 404 })
    },
  })
  try {
    const api = createRemoteApi({ url: `http://127.0.0.1:${server.port}` })
    expect((await api.status())?.pid).toBe(7)
    const flow = await api.login("qq")
    expect(flow).toBe("flow-9")
    const steps: string[] = []
    for await (const step of api.events(flow, new AbortController().signal)) steps.push(step.type)
    expect(steps).toEqual(["qr", "done"])
    await api.input(flow, { token: "t" })
    expect(inputs).toEqual([{ value: { token: "t" } }])
    expect(api.test("qq", "1")).rejects.toThrow("not remote")
  } finally {
    server.stop(true)
  }
  expect(await createRemoteApi({ url: `http://127.0.0.1:${server.port}` }).status()).toBeUndefined()
})

const running: DaemonStatus = { pid: 42, port: 4097, version: "0.0.33", connectors: [wechat] }
const plist = "/home/me/Library/LaunchAgents/dev.mtty.miao.remote.plist"

/**
 * This machine's side without a daemon: logins reuse the in-memory flow fake,
 * and start/stop return scripted plans and results. Nothing is executed.
 */
function machine(input: {
  readonly remote: ReturnType<typeof daemon>
  readonly saved: ReadonlyArray<ConnectorStatus>
  readonly start?: DaemonResult
}) {
  const flows = daemon(undefined)
  const state = { saved: input.saved }
  const plans: Record<"launchd" | "detached", DaemonPlan> = {
    launchd: { mode: "launchd", commands: [`# 写入 ${plist}`, `launchctl bootstrap gui/501 ${plist}`] },
    detached: { mode: "detached", commands: ["/usr/local/bin/miao remote >> /home/me/remote.log 2>&1 &"] },
  }
  const local: RemoteLocal = {
    status: async () => state.saved,
    login: flows.api.login,
    events: flows.api.events,
    input: flows.api.input,
    cancel: flows.api.cancel,
    remove: flows.api.remove,
    daemon: {
      startPlan: async (mode) => plans[mode],
      start: async (mode) => {
        flows.calls.push({ name: "start", args: [mode] })
        const result = input.start ?? { ok: true, log: "/home/me/remote.log" }
        if (result.ok) input.remote.set(running)
        return result
      },
      stopPlan: async (pid) => ({ mode: "detached", commands: [`kill -TERM ${pid}`] }),
      stop: async (pid) => {
        flows.calls.push({ name: "stop", args: [pid] })
        input.remote.set(undefined)
        return { ok: true, log: "/home/me/remote.log" }
      },
    },
  }
  return {
    local,
    calls: flows.calls,
    push: flows.push,
    save: (next: ReadonlyArray<ConnectorStatus>) => void (state.saved = next),
  }
}

test("without a daemon, logs in on this machine and lists the account as logged in but not running", async () => {
  await using tmp = await tmpdir()
  const remote = daemon(undefined)
  const here = machine({ remote, saved: [{ ...wechat, accounts: [] }, qq] })
  const view = await mount(tmp.path, environment(remote.api, { local: here.local }))
  try {
    const frame = await view.until((value) => value.includes("○ 未接入") && value.includes("QQ 机器人"))
    expect(frame).toContain("○ 未运行（127.0.0.1:4097）")
    expect(frame).toContain("启动守护进程（launchd 常驻）")
    expect(frame).toContain("仅本次启动（后台）")
    expect(frame).not.toContain("前台启动")

    // Rows: daemon, launchd start, detached start, WeChat, QQ.
    await view.select(4)
    await view.until(() => here.calls.some((call) => call.name === "login"))
    expect(here.calls.find((call) => call.name === "login")?.args).toEqual(["qq"])
    here.push({
      type: "qr",
      content: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=t1",
      hint: "用手机 QQ 扫码",
    })
    const qr = await view.until((value) => value.includes("扫不了时用手机打开"))
    expect(qr).toContain("接入 QQ 机器人")
    expect(qr).toMatch(/[▀▄█]{8}/)

    here.save([
      { ...wechat, accounts: [] },
      { ...qq, accounts: [{ ...wechat.accounts[0], connector: "qq", account: "102000001", state: "offline" }] },
    ])
    here.push({ type: "done", connector: "qq", account: { id: "102000001", label: "QQ 机器人" } })
    // The toast wraps, so match its first line.
    await view.until((value) => value.includes("已接入QQ 机器人（102000001）。启动守护进程后即可在手机"))
    const list = await view.until((value) => value.includes("● 已登录（守护进程未运行）"))
    expect(list).toContain("QQ 机器人 102000001")
    expect(remote.calls).toEqual([])
    expect(here.calls.some((call) => call.name === "start")).toBe(false)
  } finally {
    view.cleanup()
  }
})

test("starting the daemon shows the launchctl command, runs nothing until confirmed, then follows the daemon", async () => {
  await using tmp = await tmpdir()
  const remote = daemon(undefined)
  const here = machine({ remote, saved: [qq] })
  const view = await mount(tmp.path, environment(remote.api, { local: here.local }))
  try {
    await view.until((value) => value.includes("启动守护进程（launchd 常驻）"))
    await view.select(1)
    const confirm = await view.until((value) => value.includes("将要运行"))
    expect(confirm).toContain(`launchctl bootstrap gui/501 ${plist}`)
    expect(confirm).toContain("登录系统后自动运行")
    await view.app.mockInput.pressEscape()
    await view.until((value) => value.includes("○ 未运行"))
    expect(here.calls.some((call) => call.name === "start")).toBe(false)

    await view.select(1)
    await view.until((value) => value.includes("将要运行"))
    await view.app.mockInput.pressEnter()
    const daemonView = await view.until((value) => value.includes("● 运行中 127.0.0.1:4097（pid 42）"))
    expect(daemonView).toContain("停止守护进程")
    expect(daemonView).toContain("微信 bot@im.bot")
    expect(here.calls.filter((call) => call.name === "start")).toEqual([{ name: "start", args: ["launchd"] }])
  } finally {
    view.cleanup()
  }
})

test("off macOS only the detached start is offered, and a failed start shows the error and the manual command", async () => {
  await using tmp = await tmpdir()
  const remote = daemon(undefined)
  const here = machine({ remote, saved: [qq], start: { ok: false, error: "spawn ENOENT" } })
  const view = await mount(tmp.path, environment(remote.api, { local: here.local, platform: "linux" }))
  try {
    const frame = await view.until((value) => value.includes("启动守护进程（后台）"))
    expect(frame).not.toContain("launchd")
    await view.select(1)
    const confirm = await view.until((value) => value.includes("将要运行"))
    expect(confirm).toContain("miao remote >> /home/me/remote.log 2>&1 &")
    await view.app.mockInput.pressEnter()
    const failed = await view.until((value) => value.includes("启动失败"))
    expect(failed).toContain("spawn ENOENT")
    expect(failed).toContain("可以在终端里手动执行")
    expect(here.calls.filter((call) => call.name === "start")).toEqual([{ name: "start", args: ["detached"] }])
  } finally {
    view.cleanup()
  }
})

test("stopping the daemon asks first, then signals the pid it reported", async () => {
  await using tmp = await tmpdir()
  const remote = daemon(running)
  const here = machine({ remote, saved: [] })
  const view = await mount(tmp.path, environment(remote.api, { local: here.local }))
  try {
    await view.until((value) => value.includes("停止守护进程"))
    await view.select(1)
    const confirm = await view.until((value) => value.includes("kill -TERM 42"))
    expect(confirm).toContain("手机上的 IM 将不再响应")
    expect(here.calls).toEqual([])
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("○ 未运行（127.0.0.1:4097）"))
    expect(here.calls).toEqual([{ name: "stop", args: [42] }])
  } finally {
    view.cleanup()
  }
})

function deviceControl(enabled = true) {
  const publicKey = `B${"A".repeat(86)}`
  const issued: RemoteAccess.Invitation = {
    version: 1,
    pairingID: "pairing_device_01",
    secret: "1".repeat(64),
    hubURL: "https://relay.example.invalid",
    hostID: "host_device_0001",
    runtimeID: "runtime_device_01",
    hostPublicKey: publicKey,
    expiresAt: Date.now() + 120_000,
  }
  const state = {
    status: { enabled, connected: enabled } as RemoteAccess.Status,
    policy: undefined as RemoteAccess.Policy | undefined,
    pending: [] as RemoteAccess.Candidate[],
    grants: [] as RemoteAccess.Grant[],
  }
  const calls: Array<{ name: string; args: unknown }> = []
  const api: DeviceApi = {
    get: async () => state.status,
    invite: async (policy) => {
      calls.push({ name: "invite", args: policy })
      state.policy = policy
      return issued
    },
    pending: async () => state.pending,
    devices: async () => state.grants,
    approve: async (input) => {
      calls.push({ name: "approve", args: input })
      const candidate = state.pending.find((item) => item.pairingID === input.pairingID)!
      const grant: RemoteAccess.Grant = {
        ...candidate.policy,
        id: "grant_device_0001",
        publicKey: candidate.candidate.publicKey,
        label: candidate.candidate.label,
        version: 1,
        createdAt: Date.now(),
        revokedAt: null,
      }
      state.pending = state.pending.filter((item) => item !== candidate)
      state.grants = [...state.grants, grant]
      return grant
    },
    reject: async (input) => {
      calls.push({ name: "reject", args: input })
      state.pending = state.pending.filter((item) => item.pairingID !== input.pairingID)
    },
    revoke: async (input) => {
      calls.push({ name: "revoke", args: input })
      const grant = state.grants.find((item) => item.id === input.grantID)!
      const revoked = { ...grant, version: grant.version + 1, revokedAt: Date.now() }
      state.grants = state.grants.map((item) => (item === grant ? revoked : item))
      return revoked
    },
  }
  return { api, state, calls, issued, publicKey }
}

async function openDevices(view: Awaited<ReturnType<typeof mount>>) {
  await view.until((frame) => frame.includes("扫码、批准设备和撤销授权"))
  await view.app.mockInput.typeText("Web")
  await view.app.mockInput.pressEnter()
  await view.until((frame) => frame.includes("中继已连接") || frame.includes("中继尚未配置"))
}

test("device access is available without IM and shows an unconfigured relay truthfully", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl(false)
  const view = await mount(tmp.path, environment(daemon(undefined).api, { devices: control.api }))
  try {
    await openDevices(view)
    const frame = await view.until((value) => value.includes("中继尚未配置"))
    expect(frame).not.toContain("分享当前会话")
    expect(frame).not.toContain("持续接入")
    expect(control.calls).toEqual([])
  } finally {
    view.cleanup()
  }
})

test("read-only pairing is scoped and needs exact-key owner approval without cancelling on confirmation", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const copied: string[] = []
  const view = await mount(tmp.path, environment(daemon(undefined).api, { devices: control.api }), {
    write: async (text) => void copied.push(text),
  })
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("只读")
    await view.app.mockInput.pressEnter()
    const frame = await view.until((value) => value.includes("二维码到期"))
    expect(frame).not.toContain(control.issued.secret)
    expect(control.state.policy?.permissions).toEqual(["read"])
    expect(control.state.policy?.projectIDs).toEqual([])
    expect(control.state.policy?.sessionIDs).toEqual(["ses_current"])
    expect(control.state.policy!.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000)

    // Issuing an invitation resets the old search. Copy is the first action.
    await view.select(0)
    await view.until(() => copied.length === 1)
    expect(copied[0]).toStartWith("miao://pair#")
    const url = new URL(copied[0])
    expect(url.search).toBe("")
    expect(JSON.parse(Buffer.from(url.hash.slice(1), "base64url").toString())).toEqual(control.issued)

    control.state.pending = [
      {
        pairingID: control.issued.pairingID,
        candidate: { publicKey: control.publicKey, label: "iPhone\u001b\u202e", clientChallenge: "challenge" },
        policy: control.state.policy!,
        expiresAt: control.issued.expiresAt,
      },
    ]
    // Polling is real; wait for the pending row.
    await view.until((value) => value.includes("等待批准"), 5000)
    await view.app.mockInput.typeText("iPhone")
    await view.app.mockInput.pressEnter()
    const confirm = await view.until((value) => value.includes("名称由设备提供"))
    expect(confirm).toContain(
      createHash("sha256").update(Buffer.from(control.publicKey, "base64url")).digest("base64url"),
    )
    expect(confirm).toContain("权限：read")
    expect(confirm).toContain("会话：ses_current")
    expect(confirm).not.toContain("\u202e")
    expect(control.calls.filter((call) => call.name === "approve" || call.name === "reject")).toEqual([])
    // Cancel is selected first. Returning to the list must keep the invitation alive.
    await view.select(0)
    await view.until((value) => value.includes("二维码到期"))
    expect(control.calls.some((call) => call.name === "reject")).toBe(false)
    await Bun.sleep(30)
    await view.app.mockInput.typeText("iPhone")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("名称由设备提供"))
    await view.select(1)
    await view.until((value) => value.includes("设备已授权"))
    expect(control.calls.filter((call) => call.name === "approve")).toEqual([
      {
        name: "approve",
        args: { pairingID: control.issued.pairingID, publicKey: control.publicKey },
      },
    ])
    expect(control.calls.some((call) => call.name === "reject")).toBe(false)
  } finally {
    view.cleanup()
  }
  expect(control.calls.some((call) => call.name === "reject")).toBe(false)
})

test("closing an invitation cancels it and persistent access only covers the current project", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const view = await mount(
    tmp.path,
    environment(daemon(undefined).api, { devices: control.api, projectID: "proj_current" }),
  )
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("持续接入")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("二维码到期"))
    expect(control.state.policy?.projectIDs).toEqual(["proj_current"])
    expect(control.state.policy?.sessionIDs).toEqual([])
    expect(control.state.policy?.permissions).toContain("session.create")
    expect(control.state.policy!.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000)
    await view.app.mockInput.pressEscape()
    await view.until(() => control.calls.some((call) => call.name === "reject"))
    expect(control.calls.filter((call) => call.name === "reject")).toEqual([
      {
        name: "reject",
        args: { pairingID: control.issued.pairingID },
      },
    ])
  } finally {
    view.cleanup()
  }
})

test("revocation confirms the observed grant version and leaves execution running", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  control.state.grants = [
    {
      id: "grant_device_0001",
      version: 7,
      publicKey: control.publicKey,
      label: "iPad",
      permissions: ["read", "prompt"],
      projectIDs: ["proj_current"],
      sessionIDs: [],
      expiresAt: Date.now() + 86_400_000,
      createdAt: Date.now(),
      revokedAt: null,
    },
  ]
  const view = await mount(tmp.path, environment(daemon(undefined).api, { devices: control.api }))
  try {
    await openDevices(view)
    await view.until((value) => value.includes("已授权设备"))
    await view.app.mockInput.typeText("iPad")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("撤销会断开设备连接"))
    expect(control.calls).toEqual([])
    await view.select(1)
    await view.until((value) => value.includes("设备已撤销；运行中的任务继续执行"))
    expect(control.calls).toEqual([{ name: "revoke", args: { grantID: "grant_device_0001", version: 7 } }])
  } finally {
    view.cleanup()
  }
})

test("an invitation issued after the window closes is cancelled rather than leaked", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const release = Promise.withResolvers<RemoteAccess.Invitation>()
  const api: DeviceApi = {
    ...control.api,
    invite: async (policy) => {
      control.calls.push({ name: "invite", args: policy })
      return release.promise
    },
  }
  const view = await mount(tmp.path, environment(daemon(undefined).api, { devices: api }))
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("只读")
    await view.app.mockInput.pressEnter()
    await view.until(() => control.calls.some((call) => call.name === "invite"))
    await view.app.mockInput.pressEscape()
    await view.until((value) => !value.includes("Web / iOS 设备"))
    release.resolve(control.issued)
    await view.until(() => control.calls.some((call) => call.name === "reject"))
    expect(control.calls.filter((call) => call.name === "reject")).toEqual([
      {
        name: "reject",
        args: { pairingID: control.issued.pairingID },
      },
    ])
  } finally {
    release.resolve(control.issued)
    view.cleanup()
  }
})

test("pairing failures never display a secret carried by SDK error details", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const api: DeviceApi = {
    ...control.api,
    invite: async () => {
      throw new Error(`request failed: ${JSON.stringify(control.issued)}`)
    },
  }
  const view = await mount(tmp.path, environment(daemon(undefined).api, { devices: api }))
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("只读")
    await view.app.mockInput.pressEnter()
    const frame = await view.until((value) => value.includes("操作未完成"))
    expect(frame).not.toContain(control.issued.secret)
    expect(frame).not.toContain(control.issued.hostPublicKey)
  } finally {
    view.cleanup()
  }
})
