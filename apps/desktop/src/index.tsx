import { PlatformProvider, type Platform } from "@miao/app"
import "@miao/app/index.css"
import { Channel, invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { openUrl } from "@tauri-apps/plugin-opener"
import { relaunch } from "@tauri-apps/plugin-process"
import { createResource, Show } from "solid-js"
import { render } from "solid-js/web"
import { SessionSurface } from "./session-surface"

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

function awaitInitialization() {
  return invoke<ServerReadyData>("await_initialization", { events: new Channel() })
}

function Desktop() {
  const [ready] = createResource(awaitInitialization)

  return (
    <Show when={ready.latest} fallback={<div class="h-dvh bg-v2-background-bg-deep" />}>
      {(data) => (
        <PlatformProvider value={platform}>
          <SessionSurface url={data().url} token={data().password ?? ""} />
        </PlatformProvider>
      )}
    </Show>
  )
}

render(() => <Desktop />, document.getElementById("root")!)
