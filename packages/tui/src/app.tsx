import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { registerOpencodeSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Global } from "@miao/core/global"
import { Flag } from "@miao/core/flag/flag"
import { InstallationVersion } from "@miao/core/installation/version"
import { DiagnosticMetrics } from "@miao/core/diagnostic-metrics"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider, useEpilogue } from "./context/epilogue"
import * as Selection from "./util/selection"
import { createCliRenderer, MouseButton } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  on,
  createResource,
} from "solid-js"
import { TuiPathsProvider, TuiStartupProvider, TuiTerminalEnvironmentProvider, useTuiStartup } from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { ProjectProvider, useProject } from "./context/project"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { SDKProvider, useSDK } from "./context/sdk"
import { StartupLoading } from "./component/startup-loading"
import { SyncProvider, useSync } from "./context/sync"
import { DataProvider } from "./context/data"
import { LocationProvider } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { PermissionProvider } from "./context/permission"
import { DialogModel } from "./component/dialog-model"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogRemote, RemoteLocalProvider, type RemoteLocalFactory } from "./component/dialog-remote"
import { DialogStatus } from "./component/dialog-status"
import { DialogDebug } from "./component/dialog-debug"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogCurrencyList } from "./component/dialog-currency-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogAgent } from "./component/dialog-agent"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogWorkspaceList } from "./component/dialog-workspace-list"
import { ThemeProvider, useTheme } from "./context/theme"
import { Home } from "./routes/home"
// The session route pulls the transcript, editor, syntax, and diff graph — by
// far the largest slice of the TUI's startup heap. Load it when a session is
// first shown so the home screen does not pay for it.
function Session() {
  // Solid's lazy/Suspense inserts an empty text placeholder while loading.
  // OpenTUI rejects text nodes outside <text>, leaving the session route blank.
  const [component] = createResource(async () => {
    const { Session } = await import("./routes/session")
    return Session
  })
  return (
    <Show
      when={component()}
      keyed
      fallback={
        <box flexGrow={1}>
          <text>Loading session…</text>
        </box>
      }
    >
      {(Component) => <Component />}
    </Show>
  )
}
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { ToastProvider, useToast } from "./ui/toast"
import { isDefaultTitle } from "./util/session"
import { Locale } from "./util/locale"
import { sessionEpilogue } from "./util/presentation"
import { KVProvider, useKV } from "./context/kv"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import { openUrl } from "@miao/core/open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig, type TuiConfig } from "./config"
import { createTuiApiAdapters } from "./plugin/adapters"
import { createTuiApi } from "./plugin/api"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime, type TuiPluginHost } from "./plugin/runtime"
import { CommandPaletteDialog } from "./component/command-palette"
import {
  COMMAND_PALETTE_COMMAND,
  MIAO_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "./keymap"

import type { EventSource } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { createTuiAttention } from "./attention"
import * as TuiAudio from "./audio"
import {
  vtSupported,
  win32DisableProcessedInput,
  win32EnableVirtualTerminal,
  win32FlushInputBuffer,
} from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"

registerOpencodeSpinner()

const appGlobalBindingCommands = [
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "miao.status",
  "miao.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "diff.open",
  "workspace.list",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  onSessionChange?: (session?: { sessionID?: string; cwd?: string; state: "idle" | "processing" | "awaiting" }) => void
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  pluginHost: TuiPluginHost
  /** Lets /remote-control configure the attached Runtime relay. */
  remote?: RemoteLocalFactory
  /** Warns once at startup when the attached Runtime's build differs from this client. */
  runtimeNotice?: string
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const global = yield* Global.Service
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      // Enable ANSI/VT on legacy Windows consoles before the renderer writes.
      win32EnableVirtualTerminal()
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              externalOutputMode: "passthrough",
              targetFps: 30,
              gatherStats: true,
              exitOnCtrlC: false,
              useKittyKeyboard: {},
              autoFocus: false,
              openConsoleOnError: false,
              useMouse: !Flag.MIAO_DISABLE_MOUSE && input.config.mouse && vtSupported(),
              consoleOptions: {
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
              },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      // A fatal error exits through the entry's own handler, so no scoped
      // finalizer runs and the renderer is left owning raw mode and mouse
      // tracking. "exit" listeners run synchronously inside `process.exit`,
      // which is the last point where the terminal can still be restored.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const restore = () => destroyRenderer(renderer)
          process.on("exit", restore)
          return restore
        }),
        (restore) => Effect.sync(() => process.off("exit", restore)),
      )
      // The kitty keyboard protocol encodes every key as CSI sequences and is a
      // known source of CJK IME breakage; allow turning it off to confirm.
      if (Flag.MIAO_DISABLE_KITTY_KEYBOARD) renderer.disableKittyKeyboard()
      win32DisableProcessedInput()
      yield* Effect.acquireRelease(
        Effect.sync(() => settleResizes(renderer)),
        (stop) => Effect.sync(stop),
      )
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerOpencodeKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await input.pluginHost.dispose()
          } catch (error) {
            console.error("Failed to dispose TUI plugins", error)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(TuiAudio.dispose))
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))
      const pluginRuntime = createPluginRuntime()

      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        // Do not block the first paint on terminal theme detection (which waits up
        // to 1s when the terminal does not answer). Render now and let the theme
        // resolve reactively.
        const mode = "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <TuiPathsProvider
                    value={{
                      cwd: process.cwd(),
                      home: global.home,
                      state: global.state,
                      worktree: global.data + "/worktree",
                    }}
                  >
                    <TuiTerminalEnvironmentProvider
                      value={{
                        platform: process.platform,
                        multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                        displayServer: process.env.WAYLAND_DISPLAY
                          ? "wayland"
                          : process.env.DISPLAY
                            ? "x11"
                            : undefined,
                      }}
                    >
                      <TuiStartupProvider
                        value={{
                          initialRoute: process.env.MIAO_ROUTE ? JSON.parse(process.env.MIAO_ROUTE) : undefined,
                          skipInitialLoading: Boolean(process.env.MIAO_FAST_BOOT),
                        }}
                      >
                        <ClipboardProvider>
                          <OpencodeKeymapProvider keymap={keymap}>
                            <ArgsProvider {...input.args}>
                              <KVProvider>
                                <ToastProvider>
                                  <RouteProvider
                                    initialRoute={
                                      input.args.continue
                                        ? {
                                            type: "session",
                                            sessionID: "dummy",
                                          }
                                        : undefined
                                    }
                                  >
                                    <TuiConfigProvider config={input.config}>
                                      <PluginRuntimeProvider value={pluginRuntime}>
                                        <SDKProvider
                                          url={input.url}
                                          directory={input.directory}
                                          fetch={input.fetch}
                                          headers={input.headers}
                                          events={input.events}
                                        >
                                          <PermissionProvider>
                                            <ProjectProvider>
                                              <SyncProvider>
                                                <DataProvider>
                                                  <ThemeProvider mode={mode}>
                                                    <LocalProvider>
                                                      <PromptStashProvider>
                                                        {/* Dialogs render from DialogProvider's own scope, so
                                                            /remote-control only sees this context when it is
                                                            provided above DialogProvider. */}
                                                        <RemoteLocalProvider value={input.remote}>
                                                          <DialogProvider>
                                                            <FrecencyProvider>
                                                              <PromptHistoryProvider>
                                                                <PromptRefProvider>
                                                                  <EditorContextProvider>
                                                                    <LocationProvider>
                                                                      <App
                                                                        onSnapshot={input.onSnapshot}
                                                                        onSessionChange={input.onSessionChange}
                                                                        pluginHost={input.pluginHost}
                                                                        runtimeNotice={input.runtimeNotice}
                                                                      />
                                                                    </LocationProvider>
                                                                  </EditorContextProvider>
                                                                </PromptRefProvider>
                                                              </PromptHistoryProvider>
                                                            </FrecencyProvider>
                                                          </DialogProvider>
                                                        </RemoteLocalProvider>
                                                      </PromptStashProvider>
                                                    </LocalProvider>
                                                  </ThemeProvider>
                                                </DataProvider>
                                              </SyncProvider>
                                            </ProjectProvider>
                                          </PermissionProvider>
                                        </SDKProvider>
                                      </PluginRuntimeProvider>
                                    </TuiConfigProvider>
                                  </RouteProvider>
                                </ToastProvider>
                              </KVProvider>
                            </ArgsProvider>
                          </OpencodeKeymapProvider>
                        </ClipboardProvider>
                      </TuiStartupProvider>
                    </TuiTerminalEnvironmentProvider>
                  </TuiPathsProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined) {
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
      process.exitCode = 1
    }
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: {
  onSnapshot?: () => Promise<string[]>
  onSessionChange?: TuiInput["onSessionChange"]
  pluginHost: TuiPluginHost
  runtimeNotice?: string
}) {
  const startup = useTuiStartup()
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useOpencodeKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const project = useProject()
  const exit = useExit()
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()
  const attention = createTuiAttention({ renderer, config: tuiConfig, kv })
  const clipboard = useClipboard()

  onMount(() => {
    if (props.runtimeNotice) toast.show({ message: props.runtimeNotice, variant: "warning", duration: 15000 })
  })

  createEffect(() => {
    if (!props.onSessionChange) return
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const session = sessionID ? sync.session.get(sessionID) : undefined
    const pending =
      session && (sync.data.permission[session.id]?.length ?? 0) + (sync.data.question[session.id]?.length ?? 0) > 0
    const busy =
      session &&
      sync.data.session_status[session.id]?.type !== undefined &&
      sync.data.session_status[session.id]?.type !== "idle"
    props.onSessionChange({
      sessionID: session?.id,
      cwd: session?.directory,
      state: pending ? "awaiting" : busy ? "processing" : "idle",
    })
  })
  onCleanup(() => props.onSessionChange?.())

  // The session route is lazy-loaded, so its own epilogue effect would not run
  // until that module resolves. Set it here instead, so exiting right after
  // opening a session still prints the resume hint.
  const setEpilogue = useEpilogue()
  createEffect(() => {
    if (route.data.type !== "session") {
      setEpilogue()
      return
    }
    const session = sync.session.get(route.data.sessionID)
    setEpilogue(
      sessionEpilogue({
        title: Locale.truncate(session?.title ?? "", 50),
        sessionID: session?.id,
      }),
    )
  })
  onCleanup(() => setEpilogue())

  // Renderer frame stats, sampled by the monitor alongside `tui.sync`. `frames`
  // is counted on the main thread between samples, so it measures real activity
  // rather than the renderer's per-second `fps`. `cellsPerFrame` near the
  // terminal's cell count means a full repaint; a few dozen means incremental.
  let frames = 0
  let sampledFrames = 0
  const onFrame = () => {
    frames += 1
  }
  renderer.on("frame", onFrame)
  onCleanup(() => renderer.off("frame", onFrame))
  onCleanup(
    DiagnosticMetrics.register("tui.render", () => {
      const stats = renderer.getStats()
      const round = (value: number) => Math.round(value * 100) / 100
      const delta = frames - sampledFrames
      sampledFrames = frames
      return {
        frames: delta,
        fps: round(stats.fps),
        frameTimeMs: round(stats.averageFrameTime),
        frameCallbackMs: round(stats.frameCallbackTime),
        cellsPerFrame: stats.averageCellsUpdated,
      }
    }),
  )

  const api = createTuiApi(
    createTuiApiAdapters({
      version: InstallationVersion,
      tuiConfig,
      dialog,
      keymap,
      kv,
      route,
      routes: pluginRuntime.routes,
      event,
      sdk,
      sync,
      theme: themeState,
      toast,
      renderer,
      attention,
      Slot: pluginRuntime.Slot,
    }),
  )
  const [ready, setReady] = createSignal(false)
  props.pluginHost
    .start({
      api,
      config: tuiConfig,
      runtime: pluginRuntime,
      dispose: () => attention.dispose(),
    })
    .catch((error) => {
      console.error("Failed to load TUI plugins", error)
    })
    .finally(() => {
      setReady(true)
    })

  // Let selection copy/dismiss win ahead of normal bindings when explicit copy is required.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event, clipboard)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write?.(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.MIAO_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("miao")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("miao")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "…" : session.title
      renderer.setTerminalTitle(`miao | ${title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`miao | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.api.sessions
          .fork({ sessionID: match })
          .then((forked) => ({ data: forked }))
          .then((result) => {
            if (result.data?.id) {
              route.navigate({ type: "session", sessionID: result.data.id })
            } else {
              toast.show({ message: "Failed to fork session", variant: "error" })
            }
          })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.api.sessions
      .fork({ sessionID: args.sessionID })
      .then((forked) => ({ data: forked }))
      .then((result) => {
        if (result.data?.id) {
          route.navigate({ type: "session", sessionID: result.data.id })
        } else {
          toast.show({ message: "Failed to fork session", variant: "error" })
        }
      })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  const currentWorktreeWorkspace = createMemo(() => {
    const workspaceID = project.workspace.current()
    if (!workspaceID) return
    const workspace = project.workspace.get(workspaceID)
    if (workspace?.type !== "worktree" || !workspace.directory) return
    return workspace
  })
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "clear",
        run: () => {
          dialog.clear()
          if (route.data.type !== "session") return
          const workspace = currentWorktreeWorkspace()
          const location =
            workspace?.directory != null
              ? { directory: workspace.directory, workspaceID: workspace.id }
              : undefined
          const model = local.model.current()
          void sdk.api.sessions
            .create(
              {
                agent: local.agent.current()?.name,
                model: model
                  ? { id: model.modelID, providerID: model.providerID, variant: local.model.variant.current() }
                  : undefined,
                location,
              },
              {},
            )
            .then((created) => {
              const sessionID = created?.id
              if (!sessionID) {
                toast.show({ message: "Failed to create session", variant: "error" })
                return
              }
              route.navigate({ type: "session", sessionID })
            })
            .catch(() => toast.show({ message: "Failed to create session", variant: "error" }))
        },
      },
      {
        name: "workspace.copy_path",
        title: "Copy worktree path",
        category: "Workspace",
        enabled: () => currentWorktreeWorkspace() !== undefined,
        run: async () => {
          const workspace = currentWorktreeWorkspace()
          if (!workspace?.directory) return
          await clipboard
            .write?.(workspace.directory)
            .then(() => toast.show({ message: "Copied worktree path", variant: "info" }))
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "workspace.list",
        title: "Manage workspaces",
        category: "Workspace",
        hidden: !Flag.MIAO_EXPERIMENTAL_WORKSPACES,
        slashName: "workspaces",
        run: () => {
          dialog.replace(() => <DialogWorkspaceList />)
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "model.list",
        title: "Switch model",
        suggested: true,
        category: "Agent",
        slashName: "models",
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slashAliases: ["mo"],
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: "Model cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: "Model cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: "Favorite cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: "Favorite cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "agent.list",
        title: "Switch agent",
        category: "Agent",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "mcp.list",
        title: "Toggle MCPs",
        category: "Agent",
        slashName: "mcps",
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "remote.manage",
        title: "Remote control (App, Web, WeChat, QQ)",
        category: "Agent",
        slashName: "remote-control",
        slashAliases: ["remote"],
        run: () => {
          dialog.replace(() => <DialogRemote />)
        },
      },
      {
        name: "agent.cycle",
        title: "Agent cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: "Variant cycle",
        category: "Agent",
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: "Switch model variant",
        category: "Agent",
        hidden: local.model.variant.list().length === 0,
        slashName: "variants",
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: "No variants available",
              message: "The current model does not support any variants.",
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Agent cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          local.agent.move(-1)
        },
      },
      {
        name: "provider.connect",
        title: "Connect provider",
        suggested: !connected(),
        slashName: "connect",
        run: () => {
          dialog.replace(() => <DialogProviderList />)
        },
        category: "Provider",
      },
      {
        name: "miao.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      {
        name: "miao.debug",
        title: "View debug info",
        slashName: "debug",
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: "System",
      },
      {
        name: "theme.switch",
        title: "Switch theme",
        slashName: "themes",
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: "System",
      },
      {
        name: "currency.switch",
        title: "Switch currency",
        slashName: "currency",
        slashAliases: ["cur"],
        run: () => {
          dialog.replace(() => <DialogCurrencyList />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "theme.mode.lock",
        title: locked() ? "Unlock theme mode" : "Lock theme mode",
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          openUrl("https://mtty.dev/docs/miao/guide/").catch(() => {})
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
        category: "System",
        run: () => {
          kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
      {
        name: "permission.mode",
        title:
          local.permission.mode === "auto" ? "Disable auto-approve permissions" : "Enable auto-approve permissions",
        category: "System",
        run: () => {
          local.permission.toggle()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: MIAO_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("app.global", appGlobalBindingCommands),
  }))

  useBindings(() => ({
    mode: MIAO_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  const updateNotified = new Set<string>()

  event.on("installation.update-available", (evt) => {
    const version = evt.properties.version
    if (updateNotified.has(version)) return
    updateNotified.add(version)
    toast.show({
      variant: "info",
      title: "Update available",
      message: `miao v${version} is available. Run \`miao upgrade\` to update.`,
      duration: 10000,
    })
  })

  event.on("installation.updated", (evt) => {
    toast.show({
      variant: "info",
      title: "Updated",
      message: `miao v${evt.properties.version} installed. New windows use this version; this window keeps running.`,
      duration: 15000,
    })
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? () => Selection.copy(renderer, toast, clipboard) : undefined
      }
    >
      <Show when={Flag.MIAO_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={ready} />
      </Show>
    </box>
  )
}

// The kernel coalesces SIGWINCH while a window is being dragged, and the size
// read inside the handler can still be an intermediate one: three resizes to 160
// columns arrived as two signals that both read 120. The renderer then keeps the
// stale size until the next resize. Re-read the size shortly after each signal and
// resize the renderer if it still disagrees with the terminal.
function settleResizes(renderer: Awaited<ReturnType<typeof createCliRenderer>>) {
  if (process.platform === "win32") return () => {}
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const check = () => {
    const [width, height] = process.stdout.getWindowSize?.() ?? [process.stdout.columns, process.stdout.rows]
    if (!width || !height) return
    if (width === renderer.terminalWidth && height === renderer.terminalHeight) return
    renderer.resize(width, height)
  }
  const onResize = () => {
    for (const delay of [60, 250]) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        check()
      }, delay)
      timers.add(timer)
    }
  }
  process.on("SIGWINCH", onResize)
  return () => {
    process.off("SIGWINCH", onResize)
    for (const timer of timers) clearTimeout(timer)
  }
}
