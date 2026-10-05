import { Schema } from "effect"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeDiscovery } from "@miao/core/runtime/discovery"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { ControlHub } from "@miao/remote-control/hub"
import { DeviceGrants } from "@miao/remote-control/grants"

export async function run() {
  const root = path.resolve(import.meta.dir, "../../../..")
  const directory = await mkdtemp(path.join(tmpdir(), "miao-app-runtime-"))
  const database = path.join(directory, "sessions.db")
  const project = path.join(directory, "project")
  const runID = crypto.randomUUID()
  const sessionID = "ses_native_ui_" + runID.replaceAll("-", "")
  const title = "Native runtime session"
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const token = crypto.randomUUID() + crypto.randomUUID()
  const hub = ControlHub.listen({ port: 0, hosts: new Map([[grants.hostID, token]]) })
  const configuration = path.join(directory, "control.json")
  const fixture = path.join(directory, "ui-fixture.json")
  const environment = {
    ...process.env,
    MIAO_DB: database,
    MIAO_REMOTE_CONTROL_CONFIG: configuration,
    MIAO_PURE: "1",
    MIAO_CONFIG_CONTENT: JSON.stringify({
      model: "fixture/missing",
      formatter: false,
      lsp: false,
      remote: { projects: {} },
    }),
    MIAO_TEST_HOME: path.join(directory, "home"),
    MIAO_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  }
  const state: {
    runtime?: ReturnType<typeof Bun.spawn>
    ui?: ReturnType<typeof Bun.spawn>
    simulator?: string
    approvalError?: unknown
  } = {}
  const runtimeOutput: { stdout?: Promise<string>; stderr?: Promise<string> } = {}
  const Session = Schema.Struct({
    data: Schema.Struct({ id: Schema.String, projectID: Schema.String, title: Schema.String }),
  })
  const Candidates = Schema.Array(
    Schema.Struct({ pairingID: Schema.String, candidate: Schema.Struct({ publicKey: Schema.String }) }),
  )
  const Invitation = Schema.Struct({
    version: Schema.Literal(1),
    pairingID: Schema.String,
    secret: Schema.String,
    hubURL: Schema.String,
    hostID: Schema.String,
    runtimeID: Schema.String,
    hostPublicKey: Schema.String,
    expiresAt: Schema.Number,
  })
  let stopApproval = false
  let approvalTask: Promise<void> | undefined

  try {
    // Boot once before the Runtime or its short-lived invitation exists. Simulator
    // migration must not contend with the owner API approval watcher on small CI hosts.
    const prepare = Bun.spawn(["sh", "apps/ios/scripts/test-app.sh", process.env.MIAO_UI_TEST_FAMILY ?? "iphone"], {
      cwd: root,
      env: { ...process.env, MIAO_UI_TEST_ACTION: "prepare", MIAO_UI_TEST_DEVICE: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    state.ui = prepare
    const preparation = new Response(prepare.stdout).text()
    const preparationErrors = new Response(prepare.stderr).text()
    const preparationTimeout = setTimeout(() => prepare.kill(), 180_000)
    try {
      if ((await prepare.exited) !== 0) throw new Error("Native fixture simulator preparation failed")
      const output = await preparation
      const simulator = output.trim().split("\n").at(-1)
      if (!simulator || !/^[A-Fa-f0-9-]{36}$/.test(simulator))
        throw new Error("Native fixture simulator identity missing")
      state.simulator = simulator
    } finally {
      clearTimeout(preparationTimeout)
      await Bun.write(path.join(directory, "simulator.log"), (await preparation) + "\n" + (await preparationErrors))
    }
    // Complete native compilation before issuing a short-lived invitation or starting the Runtime.
    const build = Bun.spawn(
      [
        "sh",
        "apps/ios/scripts/test-app.sh",
        process.env.MIAO_UI_TEST_FAMILY ?? "iphone",
        `MIAO_UI_TEST_FIXTURE=${fixture}`,
        "-derivedDataPath",
        path.join(directory, "derived"),
      ],
      {
        cwd: root,
        env: { ...process.env, MIAO_UI_TEST_ACTION: "build-for-testing", MIAO_UI_TEST_DEVICE: state.simulator },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    state.ui = build
    const buildOutput = new Response(build.stdout).text()
    const buildErrors = new Response(build.stderr).text()
    const buildTimeout = setTimeout(() => build.kill(), 240_000)
    try {
      if ((await build.exited) !== 0) throw new Error("Native live fixture build failed")
    } finally {
      clearTimeout(buildTimeout)
      await Bun.write(path.join(directory, "build.log"), (await buildOutput) + "\n" + (await buildErrors))
    }
    await mkdir(project)
    if ((await Bun.spawn(["git", "init", "--quiet", project]).exited) !== 0)
      throw new Error("Fixture project initialization failed")
    if (
      (await Bun.spawn([
        "git",
        "-C",
        project,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "fixture",
      ]).exited) !== 0
    )
      throw new Error("Fixture project commit failed")
    await Bun.write(
      configuration,
      JSON.stringify({
        hubURL: `http://127.0.0.1:${hub.port}`,
        hostToken: token,
        grantFile: "devices.json",
        allowLoopbackHTTP: true,
      }),
    )
    await chmod(configuration, 0o600)
    await grants.close()
    const runtimeProcess = Bun.spawn([process.execPath, "run", "src/index.ts", "runtime"], {
      cwd: path.join(root, "packages/miao"),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    })
    state.runtime = runtimeProcess
    runtimeOutput.stdout = new Response(runtimeProcess.stdout).text()
    runtimeOutput.stderr = new Response(runtimeProcess.stderr).text()
    const storageID = createHash("sha256")
      .update(await RuntimeOwnership.canonicalStorage(database))
      .digest("hex")
    const deadline = Date.now() + 30_000
    let record: RuntimeDiscovery.Record | undefined
    while (Date.now() < deadline) {
      if (state.runtime.exitCode !== null) throw new Error("Fixture Runtime exited before readiness")
      const candidate = await RuntimeDiscovery.read(database)
      if (candidate)
        record = await RuntimeDiscovery.attest(candidate, { version: InstallationVersion, storageID }).catch(
          () => undefined,
        )
      if (record) break
      await Bun.sleep(100)
    }
    if (!record) throw new Error("Fixture Runtime readiness timed out")
    const runtime = record
    const headers = {
      authorization: `Basic ${Buffer.from(`miao:${runtime.credential}`).toString("base64")}`,
      "content-type": "application/json",
    }
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(new URL(route, runtime.url), {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Fixture API ${route} rejected with ${response.status}`)
      const value = await response.text()
      return value.length ? Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value) : undefined
    }
    await request("/api/session", { id: sessionID, location: { directory: project } })
    await request(`/api/session/${sessionID}/rename`, { title })
    const session = Schema.decodeUnknownSync(Session)(await request(`/api/session/${sessionID}`)).data
    if (session.title !== title) throw new Error("Fixture session did not receive its title")
    const invitation = Schema.decodeUnknownSync(Invitation)(
      await request("/api/runtime/control/invitation", {
        permissions: ["read", "prompt", "session.rename"],
        sessionIDs: [sessionID],
        projectIDs: [],
        // Keep the approved grant valid throughout a slow UI run. The separate
        // one-use pairing invitation still has its normal three-minute limit.
        expiresAt: Date.now() + 15 * 60_000,
      }),
    )
    await Bun.write(
      fixture,
      JSON.stringify({
        runID,
        title,
        invitation: `miao://pair#${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`,
      }),
    )
    await chmod(fixture, 0o600)
    approvalTask = (async () => {
      while (!stopApproval) {
        const candidates = Schema.decodeUnknownSync(Candidates)(await request("/api/runtime/control/pairing"))
        const candidate = candidates.find((value) => value.pairingID === invitation.pairingID)
        if (candidate) {
          await request(`/api/runtime/control/pairing/${invitation.pairingID}/approve`, {
            publicKey: candidate.candidate.publicKey,
          })
          return
        }
        await Bun.sleep(500)
      }
    })().catch((error: unknown) => {
      state.approvalError = error
      state.ui?.kill()
    })
    // Only a public test-fixture path reaches xcodebuild arguments. Secrets remain in the protected file.
    const ui = Bun.spawn(
      [
        "sh",
        "apps/ios/scripts/test-app.sh",
        process.env.MIAO_UI_TEST_FAMILY ?? "iphone",
        "-only-testing:MiaoUITests/PairingUITests/testRealRuntimeRenameAndDraftRecovery",
        `MIAO_UI_TEST_FIXTURE=${fixture}`,
        "-derivedDataPath",
        path.join(directory, "derived"),
        "-resultBundlePath",
        path.join(directory, "result"),
      ],
      {
        cwd: root,
        env: { ...process.env, MIAO_UI_TEST_ACTION: "test-without-building", MIAO_UI_TEST_DEVICE: state.simulator },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    state.ui = ui
    const output = new Response(ui.stdout).text()
    const errors = new Response(ui.stderr).text()
    const timeout = setTimeout(() => state.ui?.kill(), 240_000)
    try {
      if ((await state.ui.exited) !== 0) {
        const log = (await output) + "\n" + (await errors)
        await Bun.write(path.join(directory, "ui.log"), log)
        // Publish source coordinates only; XCTest logs and attachments can contain pairing secrets.
        const coordinates = [...log.matchAll(/PairingUITests\.swift:(\d+)(?::\d+)?: error:/g)]
        coordinates.forEach((match) => console.error(`Native UI assertion failed at PairingUITests.swift:${match[1]}`))
        // Fixed categories and numeric OS codes expose runner failures without publishing dynamic messages.
        console.error(
          JSON.stringify({
            testsStarted: log.includes("Test Case '-["),
            caughtError: log.includes("caught error"),
            missingElement: log.includes("No matches found"),
            renameInputMatches: /Native rename input expected=(true|false)/.exec(log)?.[1],
            renameSelection: /Native rename selection action=(button|menu|caret)/.exec(log)?.[1],
            ambiguousElement: log.includes("Multiple matching"),
            notHittable: log.includes("not hittable") || log.includes("not visible"),
            menuRecovery:
              /Native menu recovery enabled=(true|false) hittable=(true|false) state=(ready|connecting|syncing|authorizationBlocked|protocolBlocked|offline|draining|quiescent|expired|unknown)/
                .exec(log)
                ?.slice(1),
            menuGeometry: /Native menu geometry x=(-?\d+) y=(-?\d+) width=(\d+) height=(\d+) keyboard=(\d+) bars=(\d+)/
              .exec(log)
              ?.slice(1),
            fileReadError: log.includes("couldn’t be opened") || log.includes("could not be opened"),
            missingFile: log.includes("doesn’t exist") || log.includes("No such file"),
            buildFailure: log.includes("BUILD FAILED"),
            testingFailure: log.includes("TEST FAILED"),
            provisioningFailure: log.includes("No profiles for") || log.includes("No Accounts"),
            exitCode: state.ui.exitCode,
            approvalFailed: state.approvalError !== undefined,
            approvalTimeout: state.approvalError instanceof Error && state.approvalError.name === "TimeoutError",
            approvalHTTPStatus:
              state.approvalError instanceof Error
                ? Number(/rejected with (\d+)$/.exec(state.approvalError.message)?.[1] ?? 0)
                : 0,
            runtimeExitCode: state.runtime?.exitCode,
            osErrors: [...log.matchAll(/(NSCocoaErrorDomain|NSPOSIXErrorDomain)[^\n]{0,80}?Code=(\d+)/g)].map(
              (match) => ({ domain: match[1], code: Number(match[2]) }),
            ),
          }),
        )
        throw new Error("Native live Runtime UI test failed")
      }
      await Bun.write(path.join(directory, "ui.log"), (await output) + "\n" + (await errors))
      if (state.approvalError !== undefined) throw new Error("Fixture owner approval failed")
      const renamed = Schema.decodeUnknownSync(Session)(await request(`/api/session/${sessionID}`)).data
      if (renamed.title !== "Native phone rename") throw new Error("UI did not mutate the real Runtime session")
      const history = Schema.decodeUnknownSync(
        Schema.Struct({ data: Schema.Array(Schema.Struct({ type: Schema.String, data: Schema.Unknown })) }),
      )(await request(`/api/session/${sessionID}/history`))
      const admissions = history.data
        .filter((event) => event.type === "session.next.prompt.admitted")
        .map((event) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              sessionID: Schema.String,
              prompt: Schema.Struct({ text: Schema.String }),
              delivery: Schema.Literal("queue"),
            }),
          )(event.data),
        )
      if (
        admissions.length !== 1 ||
        admissions[0].sessionID !== sessionID ||
        admissions[0].prompt.text !== "retained phone draft"
      )
        throw new Error("The phone must admit exactly one queued input in the real Runtime")
      console.log(
        "Native App pairing, real Runtime read/rename/queue admission, protected draft background recovery and process restart passed",
      )
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    stopApproval = true
    state.ui?.kill()
    state.runtime?.kill()
    await approvalTask
    await state.runtime?.exited
    await runtimeOutput.stdout
    await runtimeOutput.stderr
    await hub.stop()
    if (state.simulator) {
      await Bun.spawn(["xcrun", "simctl", "shutdown", state.simulator], { stdout: "ignore", stderr: "ignore" }).exited
      await Bun.spawn(["xcrun", "simctl", "delete", state.simulator], { stdout: "ignore", stderr: "ignore" }).exited
    }
    // Retain failure evidence privately when requested; never publish invitations or device identity.
    if (process.env.MIAO_UI_TEST_KEEP_RESULTS !== "1") await rm(directory, { recursive: true, force: true })
  }
}

export * as NativeAppTest from "./native-app"
