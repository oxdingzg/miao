import {
  AppBaseProviders,
  AppInterface,
  normalizeLocale,
  PlatformProvider,
  ServerConnection,
  type Platform,
} from "@miao/app"
import "@miao/app/index.css"
import { MemoryRouter, createMemoryHistory, type BaseRouterProps } from "@solidjs/router"
import { Channel, invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { openUrl } from "@tauri-apps/plugin-opener"
import { relaunch } from "@tauri-apps/plugin-process"
import { createResource, Show } from "solid-js"
import { render } from "solid-js/web"

// The shell hands the renderer one sidecar and nothing else: the loopback URL
// plus the credentials it generated for this launch. Every other capability the
// app needs is the engine's own protocol.
type ServerReadyData = { url: string; username?: string | null; password?: string | null }

const platform: Platform = {
  platform: "desktop",
  openExternal: (url) => void openUrl(url),
  restart: () => relaunch(),
  notify: async (title, description) => {
    if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return
    sendNotification({ title, body: description })
  },
  openDirectoryPickerDialog: (options) =>
    open({ directory: true, multiple: options?.multiple ?? false, title: options?.title }),
}

const router = (props: BaseRouterProps) => <MemoryRouter history={createMemoryHistory()} {...props} />

function awaitInitialization() {
  return invoke<ServerReadyData>("await_initialization", { events: new Channel() })
}

function Desktop() {
  const [ready] = createResource(awaitInitialization)

  return (
    <Show when={ready.latest} fallback={<div class="h-dvh bg-v2-background-bg-deep" />}>
      {(data) => {
        const server: ServerConnection.Sidecar = {
          type: "sidecar",
          variant: "base",
          displayName: "local",
          http: {
            url: data().url,
            username: data().username ?? undefined,
            password: data().password ?? undefined,
          },
        }
        return (
          <PlatformProvider value={platform}>
            <AppBaseProviders locale={normalizeLocale(navigator.language)}>
              <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} router={router} />
            </AppBaseProviders>
          </PlatformProvider>
        )
      }}
    </Show>
  )
}

render(() => <Desktop />, document.getElementById("root")!)
