import { Database } from "bun:sqlite"
import { HubService } from "@miao/remote-control/hub-service"
import { Schema } from "effect"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { readWindow } from "../fixture/window-runtime"
import { RuntimeRegistration } from "@miao/core/runtime/registration"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { InstallationVersion } from "@miao/core/installation/version"
import { ControlHub } from "@miao/remote-control/hub"
import { SecureChannel } from "@miao/remote-control/secure-channel"
import { DeviceRoster } from "@miao/remote-control/device-roster"
import { DeviceEnrollment } from "@miao/remote-control/device-enrollment"
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
  const relay = await fixtureHub(grants).catch(async (error: unknown) => {
    await grants.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  const { hub, token } = relay
  const enrollmentMode = process.env.MIAO_UI_TEST_ENROLLMENT === "1"
  const rootSigner = enrollmentMode ? await SecureChannel.createIdentity() : undefined
  const approvalToken = crypto.randomUUID() + crypto.randomUUID()
  let approveEnrollment: ((request: Request) => Promise<Response>) | undefined
  const configuration = path.join(directory, "control.json")
  const fixture = path.join(directory, "ui-fixture.json")
  const stream = { calls: 0, finish: () => {} }
  const settlement = new Promise<void>((resolve) => {
    stream.finish = resolve
  })
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/approve" && request.method === "POST")
        return approveEnrollment ? approveEnrollment(request) : new Response(null, { status: 503 })
      if (new URL(request.url).pathname === "/finish" && request.method === "GET") {
        stream.finish()
        return new Response("done")
      }
      if (request.method !== "POST") return new Response(null, { status: 404 })
      stream.calls++
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (delta: unknown, finish: string | null = null) =>
              controller.enqueue(
                encoder.encode(
                  "data: " +
                    JSON.stringify({
                      id: "native-stream",
                      object: "chat.completion.chunk",
                      created: 1,
                      model: "selection",
                      choices: [{ index: 0, delta, finish_reason: finish }],
                    }) +
                    "\n\n",
                ),
              )
            send({ role: "assistant", content: "Native live partial" })
            await settlement
            send({ content: " completed" })
            send({}, "stop")
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const environment = {
    ...process.env,
    MIAO_DB: database,
    MIAO_REMOTE_CONTROL_CONFIG: configuration,
    MIAO_PURE: "1",
    MIAO_CONFIG_CONTENT: JSON.stringify({
      model: "fixture/missing",
      providers: {
        fixture: {
          name: "Fixture",
          api: {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `http://127.0.0.1:${provider.port}/v1`,
            settings: { apiKey: "fixture", baseURL: "http://127.0.0.1:1" },
          },
          models: {
            selection: {
              name: "Remote selection fixture",
              variants: [{ id: "reasoning", body: { reasoningEffort: "high" } }],
            },
          },
        },
      },
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
        accountID: relay.accountID,
      }),
    )
    await chmod(configuration, 0o600)
    await grants.close()
    const runtimeProcess = Bun.spawn([process.execPath, "run", "test/runtime/fixture-host.ts"], {
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
    let record: RuntimeRegistration.Record | undefined
    while (Date.now() < deadline) {
      if (state.runtime.exitCode !== null) throw new Error("Fixture Runtime exited before readiness")
      const candidate = await readWindow(database)
      if (candidate)
        record = await RuntimeRegistration.attest(candidate, { version: InstallationVersion, storageID }).catch(
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
    await request("/api/runtime/control/enabled", { enabled: true })
    if (enrollmentMode && rootSigner && relay.accountID) {
      await request(`/api/runtime/control/session/${sessionID}`, { enabled: true })
      const ownerGrants = await DeviceGrants.load(path.join(directory, "devices.json"))
      const rootGrant = await ownerGrants.approve({
        publicKey: rootSigner.publicKey,
        label: "Independent signing device",
        permissions: ["read", "prompt", "session.rename", "session.selection"],
        projectIDs: [],
        sessionIDs: [sessionID],
        expiresAt: Date.now() + 30 * 60_000,
      })
      await ownerGrants.close()
      await request("/api/runtime/control/account/trust", {
        grantID: rootGrant.id,
        version: rootGrant.version,
        policy: {
          permissions: rootGrant.permissions,
          projectIDs: rootGrant.projectIDs,
          sessionIDs: rootGrant.sessionIDs,
          expiresAt: rootGrant.expiresAt,
        },
      })
      const signed = await DeviceRoster.sign(rootSigner, {
        version: 1,
        accountID: relay.accountID,
        sequence: 1,
        issuedAt: Date.now(),
        devices: [
          { publicKey: rootSigner.publicKey, label: "Independent signing device", signer: true, addedAt: Date.now() },
        ],
      })
      approveEnrollment = async (incoming) => {
        if (incoming.headers.get("authorization") !== `Bearer ${approvalToken}`)
          return new Response(null, { status: 403 })
        const body = await incoming.text()
        if (body.length > 8192) return new Response(null, { status: 413 })
        const approved = await DeviceEnrollment.approve(rootSigner, JSON.parse(body), {
          hubURL: relay.account!.origin,
          accountID: relay.accountID!,
          current: signed,
          authority: {
            accountID: relay.accountID!,
            acceptedSequence: 1,
            acceptedDigest: await DeviceRoster.fingerprint(signed.roster),
            signerKeys: [rootSigner.publicKey],
          },
          hosts: [{ hostID: ownerGrants.hostID, publicKey: ownerGrants.identity.publicKey }],
          allowLoopbackHTTP: true,
        })
        const stored = await fetch(new URL("/api/hub/roster", relay.account!.origin), {
          method: "PUT",
          headers: {
            origin: relay.account!.origin,
            authorization: `Bearer ${relay.bearer!}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sequence: approved.roster.roster.sequence,
            payload: approved.roster.roster,
            signature: approved.roster.signature,
            digest: await DeviceRoster.fingerprint(approved.roster.roster),
          }),
        })
        if (!stored.ok) return new Response(null, { status: stored.status })
        return Response.json(approved)
      }
      await Bun.write(
        fixture,
        JSON.stringify({
          runID,
          title,
          account: relay.account,
          invitation: "",
          finishURL: `http://127.0.0.1:${provider.port}/finish`,
          enrollment: {
            approveURL: `http://127.0.0.1:${provider.port}/approve`,
            approvalToken,
            rootKey: rootSigner.publicKey,
          },
        }),
      )
      await chmod(fixture, 0o600)
    } else {
      const invitation = Schema.decodeUnknownSync(Invitation)(
        await request("/api/runtime/control/invitation", {
          permissions: ["read", "prompt", "session.rename", "session.selection"],
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
          account: relay.account,
          finishURL: `http://127.0.0.1:${provider.port}/finish`,
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
    }
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
    const startedAt = Date.now()
    const progress = { stage: "notStarted", at: startedAt, timeout: "none" }
    const output = (async () => {
      const decoder = new TextDecoder()
      const chunks: string[] = []
      let tail = ""
      const reader = ui.stdout.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const text = decoder.decode(chunk.value, { stream: true })
        chunks.push(text)
        tail += text
        const stages = [
          ...tail.matchAll(
            /NativeUIStage:(launch|account|pairing|draft|rename|agent|model|relaunch|prompt|live|settlement|restart|done)\r?\n/g,
          ),
        ]
        for (const match of stages) {
          progress.stage = match[1]!
          progress.at = Date.now()
          console.log(
            JSON.stringify({
              nativeUIStage: progress.stage,
              elapsedSeconds: Math.round((progress.at - startedAt) / 1000),
            }),
          )
        }
        tail = tail.slice(tail.lastIndexOf("\n") + 1).slice(-512)
      }
      reader.releaseLock()
      chunks.push(decoder.decode())
      return chunks.join("")
    })()
    const errors = new Response(ui.stderr).text()
    // This scenario includes pairing, two selection dialogs and three App launches.
    // Bound each observed stage as well as the full scenario on slower CI simulators.
    const timeout = setInterval(() => {
      const now = Date.now()
      if (now - startedAt < 480_000 && now - progress.at < 180_000) return
      progress.timeout = now - startedAt >= 480_000 ? "scenario" : "stage"
      state.ui?.kill()
    }, 5000)
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
            nativeUIStage: progress.stage,
            timeout: progress.timeout,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
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
            enrollmentFields: /Native enrollment fields approved=(true|false) pin=(true|false) independent=(true|false) textFields=(\d+) keyboards=(\d+)/
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
      const selected = await request(`/api/session/${sessionID}`)
      if (
        typeof selected !== "object" ||
        !selected ||
        !("data" in selected) ||
        typeof selected.data !== "object" ||
        !selected.data ||
        !("agent" in selected.data) ||
        selected.data.agent !== "plan"
      )
        throw new Error("The phone must persist its agent selection in the real Runtime")
      const modelSelected = Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            model: Schema.Struct({
              id: Schema.String,
              providerID: Schema.String,
              variant: Schema.String,
            }),
          }),
        }),
      )(selected)
      if (
        modelSelected.data.model.id !== "selection" ||
        modelSelected.data.model.providerID !== "fixture" ||
        modelSelected.data.model.variant !== "reasoning"
      )
        throw new Error("The phone must persist its model and variant selection in the real Runtime")
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
      if (relay.account) console.log("Native App Hub account entry and Keychain account restoration passed")
      if (stream.calls !== 1) throw new Error("Native reconnect repeated provider execution")
      console.log(
        "Native App pairing, real Runtime read/rename/queue admission, protected draft background recovery, live generation/settlement and process restart passed",
      )
    } finally {
      clearInterval(timeout)
    }
  } finally {
    stream.finish()
    provider.stop(true)
    stopApproval = true
    state.ui?.kill()
    state.runtime?.kill()
    await approvalTask
    await state.runtime?.exited
    await runtimeOutput.stdout
    await runtimeOutput.stderr
    await hub.stop()
    relay.closeDatabase()
    await grants.close()
    if (state.simulator) {
      await Bun.spawn(["xcrun", "simctl", "shutdown", state.simulator], { stdout: "ignore", stderr: "ignore" }).exited
      await Bun.spawn(["xcrun", "simctl", "delete", state.simulator], { stdout: "ignore", stderr: "ignore" }).exited
    }
    // Retain failure evidence privately when requested; never publish invitations or device identity.
    if (process.env.MIAO_UI_TEST_KEEP_RESULTS !== "1") await rm(directory, { recursive: true, force: true })
  }
}

async function fixtureHub(grants: Awaited<ReturnType<typeof DeviceGrants.load>>) {
  if (process.env.MIAO_UI_TEST_ACCOUNT !== "1" && process.env.MIAO_UI_TEST_ENROLLMENT !== "1") {
    const token = crypto.randomUUID() + crypto.randomUUID()
    return {
      hub: ControlHub.listen({ port: 0, hosts: new Map([[grants.hostID, token]]) }),
      token,
      account: undefined,
      accountID: undefined,
      bearer: undefined,
      closeDatabase: () => {},
    }
  }
  const database = new Database(":memory:")
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const owner = { email: "native-ui@example.invalid", password: crypto.randomUUID(), name: "Native UI" }
  let hub: Awaited<ReturnType<typeof HubService.listen>> | undefined
  try {
    hub = await HubService.listen({
      database,
      baseURL: origin,
      secret: crypto.randomUUID() + crypto.randomUUID(),
      allowLoopbackHTTP: true,
      migrate: true,
      bootstrap: owner,
      hostname: "127.0.0.1",
      port,
    })
    const signIn = await fetch(origin + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(owner),
      signal: AbortSignal.timeout(15_000),
    })
    const login = signIn.headers.get("set-auth-token")
    await signIn.arrayBuffer()
    if (!signIn.ok || !login) throw new Error("Native account fixture login failed")
    const response = await fetch(origin + "/api/auth/token", {
      headers: { origin, authorization: "Bearer " + login },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error("Native account fixture token failed")
    const bearer = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(await response.json())
    const registered = await fetch(origin + "/api/hub/hosts", {
      method: "POST",
      headers: { origin, authorization: "Bearer " + bearer.token, "content-type": "application/json" },
      body: JSON.stringify({ hostID: grants.hostID, name: "Native UI computer", publicKey: grants.identity.publicKey }),
      signal: AbortSignal.timeout(15_000),
    })
    if (registered.status !== 201) throw new Error("Native account fixture registration failed")
    const host = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String, accountID: Schema.String }))(
      await registered.json(),
    )
    return {
      hub,
      token: host.token,
      accountID: host.accountID,
      bearer: bearer.token,
      account: { origin, email: owner.email, password: owner.password },
      closeDatabase: () => database.close(),
    }
  } catch (error) {
    await hub?.stop()
    database.close()
    throw error
  }
}

export * as NativeAppTest from "./native-app"
