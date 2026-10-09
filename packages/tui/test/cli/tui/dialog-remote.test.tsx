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
import type { RemoteEnvironment, RemoteLocal, RemoteLocalFactory } from "../../../src/component/dialog-remote"
import type { DeviceApi } from "../../../src/component/dialog-devices"
import type { ClipboardService } from "../../../src/context/clipboard"
import type { RemoteAccess } from "@miao/schema/remote-access"
import { createHash } from "node:crypto"

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

// Renders the real context-consuming DialogRemote the way app.tsx composes it:
// RemoteLocalProvider must sit above DialogProvider because dialogs render from
// DialogProvider's own scope and cannot see providers nested below it.
async function mountContextual(root: string, remote?: RemoteLocalFactory) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogRemote, RemoteLocalProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { ClipboardProvider },
    { ArgsProvider },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
    { SyncProvider },
    { RouteProvider },
    { ExitProvider },
    { LocationProvider },
    { createEventSource, createFetch, directory },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-remote"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
    import("../../../src/context/clipboard"),
    import("../../../src/context/args"),
    import("../../../src/context/sdk"),
    import("../../../src/context/permission"),
    import("../../../src/context/project"),
    import("../../../src/context/sync"),
    import("../../../src/context/route"),
    import("../../../src/context/exit"),
    import("../../../src/context/location"),
    import("../../fixture/tui-sdk"),
  ])
  const calls = createFetch()
  const events = createEventSource()

  function Opener() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogRemote />))
    return <text>Conversation</text>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, resolvedConfig))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={resolvedConfig}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ClipboardProvider value={undefined}>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <RouteProvider>
                                  <LocationProvider location={{ directory }}>
                                    <RemoteLocalProvider value={remote}>
                                      <DialogProvider>
                                        <Opener />
                                        <Toast />
                                      </DialogProvider>
                                    </RemoteLocalProvider>
                                  </LocationProvider>
                                </RouteProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </ClipboardProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
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
  return { app, until, cleanup: () => app.renderer.destroy() }
}

test("DialogRemote reaches the remote factory across the dialog provider boundary", async () => {
  await using tmp = await tmpdir()
  const remote: RemoteLocalFactory = async () => ({
    providers: async () => ({ providers: [] }),
    setup: async () => {
      throw new Error("unused")
    },
    setupOAuth: async () => {
      throw new Error("unused")
    },
  })
  const view = await mountContextual(tmp.path, remote)
  try {
    const frame = await view.until((value) => value.includes("登录中继并接入"))
    expect(frame).toContain("Web / iOS 设备")
  } finally {
    view.cleanup()
  }
})

const environment = (extra: Pick<RemoteEnvironment, "devices"> & Partial<RemoteEnvironment>): RemoteEnvironment => ({
  sessionID: "ses_current",
  projectID: "proj_current",
  ...extra,
})

test("relay setup masks the password and opens device pairing after configuring the Runtime", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl(false)
  let received = ""
  const local: RemoteLocal = {
    providers: async () => ({ providers: [] }),
    setup: async (input) => {
      received = input.password
      return input.runtime.configure({ hubURL: input.hubURL, hostToken: "a".repeat(43) })
    },
    setupOAuth: async () => {
      throw new Error("unused")
    },
  }
  const view = await mount(
    tmp.path,
    environment({
      local,
      devices: control.api,
      configure: async () => {
        control.state.status = { enabled: true, connected: true }
        return control.state.status
      },
    }),
  )
  try {
    await view.until((frame) => frame.includes("登录中继并接入"))
    await view.select(0)
    await view.until((frame) => frame.includes("中继地址"))
    await view.app.mockInput.typeText("https://relay.example.invalid")
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("中继账号邮箱"))
    await view.app.mockInput.typeText("owner@example.invalid")
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("这台电脑的名称"))
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("中继账号密码"))
    await view.app.mockInput.typeText("masked-fixture-password")
    const masked = await view.until((frame) => frame.includes("••••"))
    expect(masked).not.toContain("masked-fixture-password")
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("分享当前会话（只读）"))
    expect(received).toBe("masked-fixture-password")
    expect(control.state.status.enabled).toBe(true)
  } finally {
    view.cleanup()
  }
})

test("relay setup uses browser login when the hub only offers a social provider", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl(false)
  let oauthProvider = ""
  const local: RemoteLocal = {
    providers: async () => ({ providers: ["github"] }),
    setup: async () => {
      throw new Error("unused")
    },
    setupOAuth: async (input) => {
      oauthProvider = input.provider
      return input.runtime.configure({ hubURL: input.hubURL, hostToken: "b".repeat(43) })
    },
  }
  const view = await mount(
    tmp.path,
    environment({
      local,
      devices: control.api,
      configure: async () => {
        control.state.status = { enabled: true, connected: true }
        return control.state.status
      },
    }),
  )
  try {
    await view.until((frame) => frame.includes("登录中继并接入"))
    await view.select(0)
    await view.until((frame) => frame.includes("中继地址"))
    await view.app.mockInput.typeText("https://hub.example.invalid")
    await view.app.mockInput.pressEnter()
    // A single social provider skips the picker and asks for the computer name.
    await view.until((frame) => frame.includes("这台电脑的名称"))
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("分享当前会话（只读）"))
    expect(oauthProvider).toBe("github")
    expect(control.state.status.enabled).toBe(true)
  } finally {
    view.cleanup()
  }
})

test("relay setup offers the private default and custom Hub before desktop social login", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl(false)
  let selected = ""
  const local: RemoteLocal = {
    settings: async () => ({ defaultHubURL: "https://default.example.invalid" }),
    providers: async (input) => {
      selected = input.hubURL
      return { providers: ["github"] }
    },
    setup: async () => {
      throw new Error("unused password flow")
    },
    setupOAuth: async (input) => input.runtime.configure({ hubURL: input.hubURL, hostToken: "c".repeat(43) }),
  }
  const view = await mount(
    tmp.path,
    environment({
      local,
      devices: control.api,
      configure: async () => {
        control.state.status = { enabled: true, connected: true }
        return control.state.status
      },
    }),
  )
  try {
    await view.until((frame) => frame.includes("登录中继并接入"))
    await view.select(0)
    const frame = await view.until((frame) => frame.includes("选择 Hub"))
    expect(frame).toContain("使用默认 Hub")
    expect(frame).toContain("指定其他 Hub")
    await view.select(0)
    await view.until((frame) => frame.includes("这台电脑的名称"))
    await view.app.mockInput.pressEnter()
    await view.until((frame) => frame.includes("分享当前会话（只读）"))
    expect(selected).toBe("https://default.example.invalid")
    expect(control.state.status.enabled).toBe(true)
  } finally {
    view.cleanup()
  }
})

test("current-session publication sends the selected Session ID and both toggle states", async () => {
  await using tmp = await tmpdir()
  const calls: Array<{ sessionID: string; enabled: boolean }> = []
  const view = await mount(
    tmp.path,
    environment({
      devices: deviceControl(true).api,
      setSessionEnabled: async (input) => {
        calls.push(input)
        return { enabled: true, connected: true, sessionIDs: input.enabled ? [input.sessionID] : [] }
      },
    }),
  )
  try {
    await view.until((frame) => frame.includes("开启当前会话的远程控制"))
    await view.select(0)
    await view.until((frame) => frame.includes("关闭当前会话的远程控制"))
    await view.select(1)
    await view.until(() => calls.length === 2)
    expect(calls).toEqual([
      { sessionID: "ses_current", enabled: true },
      { sessionID: "ses_current", enabled: false },
    ])
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
  const view = await mount(tmp.path, environment({ devices: control.api }))
  try {
    await openDevices(view)
    const frame = await view.until((value) => value.includes("中继尚未配置"))
    expect(frame).not.toContain("分享当前会话")
    expect(frame).not.toContain("接入当前窗口")
    expect(control.calls).toEqual([])
  } finally {
    view.cleanup()
  }
})

test("private browser pairing path produces an HTTPS fragment link with the exact invitation", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const copied: string[] = []
  const local: RemoteLocal = {
    setupOAuth: async () => {
      throw new Error("unused")
    },
    settings: async () => ({ browserURL: "https://relay.example.invalid/control/" }),
    providers: async () => ({ providers: [] }),
    setup: async () => {
      throw new Error("unused")
    },
  }
  const view = await mount(tmp.path, environment({ devices: control.api, local }), {
    write: async (text) => void copied.push(text),
  })
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("只读")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("二维码到期"))
    await view.select(0)
    await view.until(() => copied.length === 1)
    const url = new URL(copied[0])
    expect(url.origin + url.pathname).toBe("https://relay.example.invalid/control/")
    expect(url.search).toBe("")
    expect(JSON.parse(Buffer.from(url.hash.slice(6), "base64url").toString())).toEqual(control.issued)
  } finally {
    view.cleanup()
  }
})

test("read-only pairing is scoped and needs exact-key owner approval without cancelling on confirmation", async () => {
  await using tmp = await tmpdir()
  const control = deviceControl()
  const copied: string[] = []
  const view = await mount(tmp.path, environment({ devices: control.api }), {
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
  const view = await mount(tmp.path, environment({ devices: control.api, projectID: "proj_current" }))
  try {
    await openDevices(view)
    await view.app.mockInput.typeText("接入当前窗口")
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
  const view = await mount(tmp.path, environment({ devices: control.api }))
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
  const view = await mount(tmp.path, environment({ devices: api }))
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
  const view = await mount(tmp.path, environment({ devices: api }))
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
