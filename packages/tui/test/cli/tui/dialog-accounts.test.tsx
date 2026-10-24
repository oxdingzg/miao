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

const providerID = "openai"

async function mount(root: string, onConnectKey?: (body: { key: string; label?: string }) => void, native = false) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogAccounts },
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
    { SyncProvider, useSync },
    { RouteProvider },
    { ExitProvider },
    { LocationProvider },
    { createFetch, createEventSource, directory, json },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-accounts"),
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

  // The dialog must observe the store it mutates, so the fake server keeps the
  // active account in memory.
  let active = "cred_work"
  const activated: string[] = []
  const pinned: string[] = []
  const sessionID = "ses_native_accounts"
  const fetch = createFetch((url, request) => {
    if (native && url.pathname === "/api/session")
      return json({
        data: [
          {
            id: sessionID,
            projectID: "proj_test",
            title: "Native",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
            location: { directory },
            execution: { engine: "rust", selection: "operator" },
            credentialID: pinned.at(-1) ?? "cred_work",
          },
        ],
        cursor: {},
      })
    if (native && url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "Native",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          location: { directory },
          execution: { engine: "rust", selection: "operator" },
          credentialID: pinned.at(-1) ?? "cred_work",
        },
      })
    if (native && url.pathname === `/api/session/${sessionID}/account`)
      return request!.json().then((body) => {
        pinned.push(body.credentialID)
        return new Response(null, { status: 204 })
      })
    if (url.pathname === `/api/integration/${providerID}`)
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: {
          id: providerID,
          name: "OpenAI",
          methods: [],
          connections: [
            { type: "credential", id: "cred_personal", label: "Personal", active: active === "cred_personal" },
            { type: "credential", id: "cred_work", label: "Work", active: active === "cred_work" },
          ],
        },
      })
    if (url.pathname === `/api/integration/${providerID}/connect/key`) {
      void request?.json().then((body) => onConnectKey?.(body as { key: string; label?: string }))
      return new Response(null, { status: 204 })
    }
    if (url.pathname.startsWith("/api/credential/") && url.pathname.endsWith("/activate")) {
      active = decodeURIComponent(url.pathname.slice("/api/credential/".length, -"/activate".length))
      activated.push(active)
      return new Response(null, { status: 204 })
    }
    return undefined
  }).fetch
  const events = createEventSource()

  function Opener() {
    const dialog = useDialog()
    const sync = useSync()
    onMount(() => {
      if (!native) return dialog.replace(() => <DialogAccounts providerID={providerID} />)
      void sync
        .bootstrap()
        .then(() => sync.session.sync(sessionID))
        .then(() => dialog.replace(() => <DialogAccounts providerID={providerID} />))
    })
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
                      <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <RouteProvider initialRoute={native ? { type: "session", sessionID } : undefined}>
                                  <LocationProvider location={{ directory }}>
                                    <DialogProvider>
                                      <Opener />
                                      <Toast />
                                    </DialogProvider>
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
  return { app, until, activated, pinned, cleanup: () => app.renderer.destroy() }
}

test("lists every account of a provider and switches the active one", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path)
  try {
    const frame = await view.until((value) => value.includes("Personal") && value.includes("Work"))
    // Both accounts are shown, with the active one marked.
    expect(frame).toContain("active")
    expect(frame).toContain("inactive")
    // The account actions are reachable, not just the rows.
    expect(frame).toContain("Rename")
    expect(frame).toContain("Remove")

    // The list opens on the active account; step up to the inactive one.
    await view.app.mockInput.pressArrow("up")
    await view.app.mockInput.pressEnter()
    await view.until(() => view.activated.length === 1)
    expect(view.activated).toEqual(["cred_personal"])
    await view.until((value) => value.includes("Personal") && value.includes("active"))
  } finally {
    view.cleanup()
  }
})

test("adds an account under the label entered before signing in", async () => {
  await using tmp = await tmpdir()
  let connected: { key: string; label?: string } | undefined
  const view = await mount(tmp.path, (body) => {
    connected = body
  })
  try {
    await view.until((value) => value.includes("Add account"))
    // Rows are Personal, Work (active, selected), then Add account.
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("New account"))
    await view.app.mockInput.typeText("team")
    await view.app.mockInput.pressEnter()
    await view.until((value) => value.includes("API key"))
    await view.app.mockInput.typeText("sk-test")
    await view.app.mockInput.pressEnter()
    await view.until(() => connected !== undefined)
    expect(connected?.label).toBe("team")
    expect(connected?.key).toBe("sk-test")
  } finally {
    view.cleanup()
  }
})

test("selecting an account in a native session pins it and refreshes its selection", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, undefined, true)
  try {
    await view.until((value) => value.includes("Personal") && value.includes("used in this session"))
    await view.app.mockInput.pressArrow("up")
    await view.app.mockInput.pressEnter()
    await view.until(() => view.pinned.length === 1)
    expect(view.pinned).toEqual(["cred_personal"])
    expect(view.activated).toEqual([])
    await view.until((value) => value.includes("inactive · used in this session"))
  } finally {
    view.cleanup()
  }
})
