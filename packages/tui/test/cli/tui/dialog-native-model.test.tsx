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

const sessionID = "ses_native_model"

async function mount(root: string, reject = false, variant = false) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogNativeModel },
    { DialogVariant },
    { LocalProvider, useLocal },
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
    import("../../../src/component/dialog-native-model"),
    import("../../../src/component/dialog-variant"),
    import("../../../src/context/local"),
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

  const selected: { model: { providerID: string; id: string; variant?: string } }[] = []
  let cycle: (() => void) | undefined
  let restore: (() => void) | undefined
  let busy: (() => boolean) | undefined
  const fetch = createFetch((url, request) => {
    if (url.pathname === `/api/session/${sessionID}/model-routes`)
      return json({
        data: [
          {
            model: { providerID: "native-engine-default", id: "default" },
            protocol: "openai-chat",
            wireModel: "shared",
            default: true,
            variants: variant ? ["high"] : [],
          },
          {
            model: { providerID: "native-engine", id: "account-two/shared" },
            variants: ["high"],
            protocol: "openai-chat",
            wireModel: "shared",
            default: false,
          },
        ],
      })
    if (url.pathname === `/api/session/${sessionID}/model`) {
      if (!request) throw new Error("missing model selection request")
      return request.json().then((body: unknown) => {
        selected.push(body as (typeof selected)[number])
        return reject
          ? json(
              { _tag: "ConflictError", message: "opaque history belongs to another route", resource: sessionID },
              { status: 409 },
            )
          : new Response(null, { status: 204 })
      })
    }
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: "Native",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          location: { directory },
          execution: { selection: "operator" },
          model:
            selected.length && !reject
              ? selected.at(-1)!.model
              : { providerID: "native-engine-default", id: "default" },
        },
      })
    return undefined
  }).fetch
  const events = createEventSource()

  function Opener() {
    const dialog = useDialog()
    const sync = useSync()
    const local = useLocal()
    cycle = () => local.model.variant.cycle()
    restore = () => local.model.variant.set("high")
    busy = () => local.model.variant.busy()
    onMount(() => {
      void sync.session
        .sync(sessionID)
        .then(() => dialog.replace(() => (variant ? <DialogVariant /> : <DialogNativeModel sessionID={sessionID} />)))
    })
    return <text>Conversation model: {sync.session.get(sessionID)?.model?.id}</text>
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
                                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                                  <LocationProvider location={{ directory }}>
                                    <LocalProvider>
                                      <DialogProvider>
                                        <Opener />
                                        <Toast />
                                      </DialogProvider>
                                    </LocalProvider>
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
  return {
    app,
    until,
    selected,
    cycle: () => cycle?.(),
    restore: () => restore?.(),
    busy: () => busy?.(),
    cleanup: () => app.renderer.destroy(),
  }
}

test("renders host routes and submits the exact reference through the native model API", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path)
  try {
    const frame = await view.until((value) => value.includes("account-two/shared"))
    expect(frame).toContain("shared (default)")
    expect(frame).toContain("openai-chat")
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    await view.until(() => view.selected.length === 1)
    expect(view.selected).toEqual([{ model: { providerID: "native-engine", id: "account-two/shared" } }])
    const updated = await view.until(
      (value) =>
        !value.includes("Select native model route") && value.includes("Conversation model: account-two/shared"),
    )
    expect(updated).toContain("Conversation model: account-two/shared")
  } finally {
    view.cleanup()
  }
})

test("keeps the route dialog open and shows engine selection errors", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, true)
  try {
    await view.until((value) => value.includes("account-two/shared"))
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    const frame = await view.until((value) => value.includes("opaque history"))
    expect(frame).toContain("Select native model route")
    expect(view.selected).toHaveLength(1)
  } finally {
    view.cleanup()
  }
})

test("host-advertised variants are selectable without inventing routes", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path)
  try {
    await view.until((value) => value.includes("account-two/shared · high"))
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    await view.until(() => view.selected.length === 1)
    expect(view.selected).toEqual([
      { model: { providerID: "native-engine", id: "account-two/shared", variant: "high" } },
    ])
  } finally {
    view.cleanup()
  }
})

test("native variant dialog selects the owning route and cycle restores its configured default", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, false, true)
  try {
    await view.until((value) => value.includes("Select variant") && value.includes("high"))
    view.restore()
    expect(view.selected).toHaveLength(0)
    await view.app.mockInput.pressArrow("down")
    await view.app.mockInput.pressEnter()
    await view.until(() => view.selected.length === 1)
    expect(view.selected[0]).toEqual({ model: { providerID: "native-engine-default", id: "default", variant: "high" } })
    await view.until((value) => !value.includes("Select variant") && !view.busy())
    view.cycle()
    await view.until(() => view.selected.length === 2)
    expect(view.selected[1]).toEqual({ model: { providerID: "native-engine-default", id: "default" } })
  } finally {
    view.cleanup()
  }
})

test("native variant cycle reports rejected selections without changing the owner model", async () => {
  await using tmp = await tmpdir()
  const view = await mount(tmp.path, true, true)
  try {
    await view.until((value) => value.includes("Select variant") && value.includes("high"))
    view.cycle()
    const frame = await view.until((value) => value.includes("opaque history"))
    expect(frame).toContain("Conversation model: default")
    expect(view.selected).toEqual([{ model: { providerID: "native-engine-default", id: "default", variant: "high" } }])
  } finally {
    view.cleanup()
  }
})
