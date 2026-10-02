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
import type { DaemonStatus, LoginStep, RemoteApi, RemoteEnvironment } from "../../../src/component/dialog-remote"

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

/** An in-memory daemon: records calls and lets the test push login steps. */
function daemon(status: DaemonStatus | undefined) {
  const calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> = []
  const steps: LoginStep[] = []
  const waiters = new Set<() => void>()
  const push = (...next: LoginStep[]) => {
    steps.push(...next)
    waiters.forEach((wake) => wake())
  }
  const api: RemoteApi = {
    status: async () => status,
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
  return { api, calls, push }
}

async function mount(root: string, environment: RemoteEnvironment) {
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
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-remote"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
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
                  <DialogProvider>
                    <Opener />
                    <Toast />
                  </DialogProvider>
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
