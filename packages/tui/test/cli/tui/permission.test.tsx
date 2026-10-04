/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

const replyPath = "/api/session/ses_test/permission/per_test/reply"

const webfetchRequest = {
  id: "per_test",
  sessionID: "ses_test",
  permission: "webfetch",
  patterns: ["https://example.com"],
  metadata: { url: "https://example.com" } as Record<string, unknown>,
  always: ["*"],
}

async function mountPermission(
  root: string,
  status: number,
  onSettled: () => void,
  delay = 0,
  request = webfetchRequest,
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { PermissionPrompt },
    { SDKProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { ArgsProvider },
    { ProjectProvider },
    { SyncProvider },
    { PermissionProvider },
    { ExitProvider },
    { LocationProvider },
  ] = await Promise.all([
    import("../../../src/routes/session/permission"),
    import("../../../src/context/sdk"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
    import("../../../src/context/args"),
    import("../../../src/context/project"),
    import("../../../src/context/sync"),
    import("../../../src/context/permission"),
    import("../../../src/context/exit"),
    import("../../../src/context/location"),
  ])
  const calls: string[] = []
  const events = createEventSource()
  const sdk = createFetch((url) => {
    if (url.pathname !== replyPath) return undefined
    calls.push(url.pathname)
    return Bun.sleep(delay).then(() =>
      status === 200
        ? new Response(null, { status: 204 })
        : json(
            {
              name: status === 404 ? "PermissionNotFoundError" : "ServiceUnavailableError",
              data: { message: status === 404 ? "Permission request not found" : "Service unavailable" },
            },
            { status },
          ),
    )
  })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={sdk.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider exit={() => {}}>
                            <SyncProvider>
                              <Toast />
                              <LocationProvider location={{ directory }}>
                                <PermissionPrompt request={request} onSettled={onSettled} />
                              </LocationProvider>
                            </SyncProvider>
                          </ExitProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !app.captureCharFrame().includes("Allow once")) {
    await Bun.sleep(20)
    await app.renderOnce()
  }
  return { app, calls }
}

test("repeated Enter on a permission prompt sends one reply", async () => {
  await using tmp = await tmpdir()
  let settled = 0
  const { app, calls } = await mountPermission(tmp.path, 200, () => settled++, 50)
  try {
    expect(app.captureCharFrame()).toContain("Allow once")
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(120)
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath])
    expect(settled).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed permission reply keeps the prompt available for retry", async () => {
  await using tmp = await tmpdir()
  let settled = 0
  const { app, calls } = await mountPermission(tmp.path, 503, () => settled++)
  try {
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath])
    expect(settled).toBe(0)
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath, replyPath])
    expect(settled).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a permission reply for a request that no longer exists dismisses the prompt once", async () => {
  await using tmp = await tmpdir()
  let settled = 0
  const { app, calls } = await mountPermission(tmp.path, 404, () => settled++)
  try {
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await Bun.sleep(60)
    expect(calls).toEqual([replyPath])
    expect(settled).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a bash permission prompt shows the stdin script in a scrollable body", async () => {
  await using tmp = await tmpdir()
  const stdin = [
    "echo first-line",
    "echo second-line",
    ...Array.from({ length: 20 }, (_, index) => `echo line-${index}`),
    "echo last-line",
  ].join("\n")
  const { app } = await mountPermission(tmp.path, 200, () => {}, 0, {
    ...webfetchRequest,
    permission: "bash",
    patterns: [`ssh host 'bash -s' \n<<stdin\n${stdin}`],
    metadata: { command: "ssh host 'bash -s'", stdin },
    always: [`ssh host 'bash -s' \n<<stdin\n${stdin}`],
  })
  try {
    await app.renderOnce()
    const compact = app.captureCharFrame()
    expect(compact).toContain("$ ssh host 'bash -s'")
    expect(compact).toContain("stdin (23 lines, 297 bytes)")
    expect(compact).toContain("echo first-line")
    expect(compact).toContain("echo second-line")
    // The rest of the script stays inside the scrollbox instead of overflowing the prompt.
    expect(compact).not.toContain("echo last-line")
    expect(compact).toContain("Allow once")

    // "Allow always" lists the saved pattern, script included, folded to a few lines.
    await app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await Bun.sleep(20)
    await app.renderOnce()
    const always = app.captureCharFrame()
    expect(always).toContain("- ssh host 'bash -s'")
    expect(always).toContain("<<stdin")
    expect(always).toContain("echo first-line")
    expect(always).not.toContain("echo line-0")
  } finally {
    app.renderer.destroy()
  }
})

test("a bash permission prompt shows the prefix rules that allow always saves", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountPermission(tmp.path, 200, () => {}, 0, {
    ...webfetchRequest,
    permission: "bash",
    patterns: ["git add .", 'git commit -m "wip"'],
    metadata: { command: 'git add . && git commit -m "wip"' },
    always: ["git add *", "git commit *"],
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow always saves: git add *, git commit *")
    expect(frame).toContain("Allow once")
  } finally {
    app.renderer.destroy()
  }
})

test("an edit permission prompt shows the file and the diff it will apply", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "src", "hello.ts")
  // The shape a V2 edit request has once sync maps it: metadata carries filepath and diff.
  const { app } = await mountPermission(tmp.path, 200, () => {}, 0, {
    ...webfetchRequest,
    permission: "edit",
    patterns: ["src/hello.ts"],
    metadata: {
      filepath: file,
      diff: `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n@@ -1,2 +1,2 @@\n-const greeting = "before"\n+const greeting = "after"\n export {}\n`,
    },
  })
  try {
    await app.renderOnce()
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("hello.ts")
    expect(frame).toContain('const greeting = "before"')
    expect(frame).toContain('const greeting = "after"')
    expect(frame).not.toContain("No diff provided")
    expect(frame).toContain("Allow once")
  } finally {
    app.renderer.destroy()
  }
})

test("an MCP permission prompt names the server and tool and summarizes the arguments", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountPermission(tmp.path, 200, () => {}, 0, {
    ...webfetchRequest,
    permission: "mcp__github__create_issue",
    patterns: ["*"],
    metadata: {
      server: "github",
      tool: "create_issue",
      input: { repo: "oxdingzg/miao", title: "Ask before MCP calls", labels: ["security"], body: "x".repeat(400) },
    },
  })
  try {
    await app.renderOnce()
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("MCP github · create_issue")
    expect(frame).toContain("Server: github")
    expect(frame).toContain("Tool: create_issue")
    expect(frame).toContain("repo: oxdingzg/miao")
    expect(frame).toContain('labels: ["security"]')
    // A long argument is clipped instead of flooding the prompt.
    expect(frame).not.toContain("x".repeat(200))
    expect(frame).toContain("Allow once")
  } finally {
    app.renderer.destroy()
  }
})
