import { run as runTui, type RemoteLocalFactory, type TuiInput } from "@miao/tui"
import { Global } from "@miao/core/global"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect } from "effect"
import { TerminalSession } from "./terminal-session"

export function run(input: TuiInput & { runtimeTarget?: TerminalSession.Runtime }) {
  return runTui({
    ...input,
    onSessionChange: input.onSessionChange ?? TerminalSession.reporter(input.runtimeTarget),
    remote: input.remote ?? remote,
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

/** Shown in the browser tab after the relay redirects back to the loopback listener. */
const callbackPage = (ok: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>miao</title></head>
<body style="font-family: system-ui, sans-serif; background: #0f1116; color: #e6e6e6; display: grid; place-items: center; height: 100vh; margin: 0">
<p style="font-size: 1rem">${ok ? "Authorization complete. You can close this tab and return to miao." : "Authorization failed. Return to miao and try again."}</p>
</body></html>`

// Relay account setup stays lazy and separate from session execution.
const remote: RemoteLocalFactory = async () => ({
  providers: async (input) => {
    const { HubSetup } = await import("@miao/remote-control/hub-setup")
    return HubSetup.providers(input)
  },
  setup: async (input) => {
    const { HubSetup } = await import("@miao/remote-control/hub-setup")
    return HubSetup.connect(input)
  },
  setupOAuth: async (input) => {
    const { HubSetup } = await import("@miao/remote-control/hub-setup")
    const { openUrl } = await import("@miao/core/open")
    let resolveCode: (code: string) => void = () => undefined
    let rejectCode: (error: Error) => void = () => undefined
    const received = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // The relay redirects the browser back here with a one-time code. Opening the
    // browser is best-effort, so the listener stays up until the flow settles.
    void received.catch(() => undefined)
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        const error = url.searchParams.get("error")
        const code = url.searchParams.get("code")
        if (error !== null) rejectCode(new Error(error))
        else if (code !== null) resolveCode(code)
        return new Response(callbackPage(error === null && code !== null), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      },
    })
    try {
      return await HubSetup.connectWithOAuth({
        hubURL: input.hubURL,
        provider: input.provider,
        name: input.name,
        runtime: input.runtime,
        callbackURL: `http://127.0.0.1:${server.port}/`,
        waitForCode: () => received,
        open: async (url) => {
          try {
            await openUrl(url)
          } catch {
            throw new Error(`Open this link in a browser to authorize this computer: ${url}`)
          }
        },
      })
    } finally {
      server.stop(true)
    }
  },
})
