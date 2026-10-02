// Conformance suite for connectors: the same cases run against every connector
// through the real host (login steps, credential storage, owner gate, pairing)
// with the connector pointed at a local fake of its network. A new connector
// only needs a fake service to reuse all of it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readAccounts } from "./accounts"
import type { Channel, Inbound } from "./channel"
import type { Connector, LoginInput, LoginStep } from "./connector"
import { createHost, type FlowStep } from "./host"

export type FakeService = {
  /** Connector settings (as from `remote.<id>`) that point the connector at this fake. */
  readonly options: Readonly<Record<string, unknown>>
  /**
   * Sees every interactive login step. Answer `code` / `form` steps by
   * returning input; after a `qr` step, make the fake complete the scan.
   */
  readonly onLoginStep: (step: LoginStep) => LoginInput | undefined | Promise<LoginInput | undefined>
  /** The person the fake login names as owner, or who sends the pairing code. */
  readonly owner: string
  readonly stranger: string
  /** Delivers one inbound text with the network's message id. */
  readonly deliver: (message: { readonly from: string; readonly text: string; readonly id: string }) => unknown
  /** Texts the connector sent, oldest first. */
  readonly sent: () => ReadonlyArray<{ readonly to: string; readonly text: string }>
  /** Breaks the live connection the way the network would; the channel must recover on its own. */
  readonly drop: () => unknown
  readonly stop: () => unknown
}

export type ConformanceSettings = {
  /** Fetch used by the connector; pass one that refuses anything but loopback. */
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export function connectorConformance(
  connector: Connector,
  start: () => Promise<FakeService>,
  settings: ConformanceSettings = {},
) {
  const timeout = settings.timeoutMs ?? 30_000
  const fixture = {
    directory: "",
    fake: undefined as FakeService | undefined,
    host: undefined as ReturnType<typeof createHost> | undefined,
    channels: [] as Channel[],
    received: [] as Inbound[],
    steps: [] as FlowStep[],
    sequence: 0,
  }
  const fake = () => {
    if (!fixture.fake) throw new Error("fake service not started")
    return fixture.fake
  }
  const host = () => {
    if (!fixture.host) throw new Error("host not created")
    return fixture.host
  }
  const nextID = () => `conformance-${Date.now()}-${++fixture.sequence}`

  describe(`connector conformance: ${connector.id}`, () => {
    beforeEach(async () => {
      fixture.directory = await mkdtemp(path.join(os.tmpdir(), `remote-conformance-${connector.id}-`))
      fixture.fake = await start()
      fixture.channels = []
      fixture.received = []
      const service = fixture.fake
      fixture.host = createHost({
        authFile: path.join(fixture.directory, "remote-auth.json"),
        stateDir: path.join(fixture.directory, "state"),
        connectors: [connector],
        options: () => service.options,
        agentVersion: "0.0.0-conformance",
        fetch: settings.fetch,
      })
      fixture.host.bind({
        add: async (channel) => {
          fixture.channels = [...fixture.channels.filter((item) => item.id !== channel.id), channel]
          await channel.start(async (message) => void fixture.received.push(message))
        },
        remove: async (id) => {
          const channel = fixture.channels.find((item) => item.id === id)
          fixture.channels = fixture.channels.filter((item) => item.id !== id)
          await channel?.stop()
        },
      })
      fixture.steps = await login()
    }, timeout)

    afterEach(async () => {
      await Promise.all(fixture.channels.map((channel) => channel.stop().catch(() => undefined)))
      await fixture.host?.close()
      await fixture.fake?.stop()
      await rm(fixture.directory, { recursive: true, force: true })
    }, timeout)

    test(
      "login ends with done, saves the account, and names or pairs an owner",
      async () => {
        const done = fixture.steps.at(-1)
        expect(done?.type).toBe("done")
        if (done?.type !== "done") return
        const accounts = await readAccounts(path.join(fixture.directory, "remote-auth.json"))
        const record = accounts[connector.id]?.[done.account.id]
        expect(record?.owner).toBe(fake().owner)
        expect(record?.pair).toBeUndefined()
        expect(connector.parse(record?.credentials)).toBeDefined()
        // Credentials never leave the host through login steps.
        expect(JSON.stringify(fixture.steps)).not.toContain('"credentials"')
        if (connector.pairing) expect(fixture.steps.some((step) => step.type === "pair")).toBe(true)
        expect(fixture.channels).toHaveLength(1)
      },
      timeout,
    )

    test(
      "receives text from the owner and ignores strangers and duplicates",
      async () => {
        const id = nextID()
        await fake().deliver({ from: fake().stranger, text: "from a stranger", id: nextID() })
        await fake().deliver({ from: fake().owner, text: "hello once", id })
        await fake().deliver({ from: fake().owner, text: "hello once", id })
        await fake().deliver({ from: fake().owner, text: "marker", id: nextID() })
        await eventually(() => fixture.received.some((message) => message.text === "marker"), timeout)
        expect(fixture.received.filter((message) => message.text === "hello once")).toHaveLength(1)
        expect(fixture.received.some((message) => message.text === "from a stranger")).toBe(false)
        expect(fixture.received.every((message) => message.user === fake().owner)).toBe(true)
      },
      timeout,
    )

    test(
      "answers an inbound message and splits text longer than one message",
      async () => {
        await fake().deliver({ from: fake().owner, text: "ping", id: nextID() })
        await eventually(() => fixture.received.some((message) => message.text === "ping"), timeout)
        const inbound = fixture.received.find((message) => message.text === "ping")
        const channel = fixture.channels[0]
        const limit = channel.capabilities.maxLength
        const long = Array.from({ length: limit * 2 + 10 }, (_, index) => String(index % 10)).join("")
        const before = fake().sent().length
        const result = await channel.send(fake().owner, long, inbound?.reply)
        expect(result.ok).toBe(true)
        expect(result.sent).toBeGreaterThanOrEqual(3)
        const pieces = fake()
          .sent()
          .slice(before)
          .filter((message) => message.to === fake().owner)
        expect(pieces.every((piece) => [...piece.text].length <= limit)).toBe(true)
        expect(pieces.map((piece) => piece.text).join("")).toBe(long)
      },
      timeout,
    )

    test(
      "keeps receiving after the connection drops",
      async () => {
        await fake().drop()
        await fake().deliver({ from: fake().owner, text: "after the drop", id: nextID() })
        await eventually(() => fixture.received.some((message) => message.text === "after the drop"), timeout)
      },
      timeout,
    )

    test(
      "declares sane limits and can reach the owner the way it claims",
      async () => {
        const capabilities = fixture.channels[0].capabilities
        expect(capabilities.maxLength).toBeGreaterThan(0)
        if (capabilities.replyWindowMs !== undefined) expect(capabilities.replyWindowMs).toBeGreaterThan(0)
        if (capabilities.repliesPerInbound !== undefined) expect(capabilities.repliesPerInbound).toBeGreaterThan(0)
        if (capabilities.pushBudgetPerDay !== undefined) expect(capabilities.pushBudgetPerDay).toBeGreaterThanOrEqual(0)
        if (!capabilities.push) return
        // A push needs no inbound message first; the host's test message is one.
        const done = fixture.steps.at(-1)
        if (done?.type !== "done") throw new Error("login did not finish")
        const result = await host().test(connector.id, done.account.id)
        expect(result.ok).toBe(true)
        expect(
          fake()
            .sent()
            .some((message) => message.to === fake().owner),
        ).toBe(true)
      },
      timeout,
    )
  })

  async function login() {
    const flow = host().login(connector.id)
    const steps: FlowStep[] = []
    for await (const step of flow.events()) {
      steps.push(step)
      if (step.type === "pair") {
        await fake().deliver({ from: fake().owner, text: step.code, id: nextID() })
        continue
      }
      if (step.type === "done" || step.type === "error") continue
      const input = await fake().onLoginStep(step)
      if (input !== undefined) flow.input(input)
    }
    const last = steps.at(-1)
    if (last?.type !== "done") throw new Error(`login did not finish: ${JSON.stringify(steps)}`)
    return steps
  }
}

export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

/** A fetch that refuses anything but 127.0.0.1, so a test can never reach a real IM service. */
export const loopbackFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "127.0.0.1") throw new Error(`test attempted a non-loopback request: ${url}`)
    return fetch(input, init)
  },
  { preconnect: () => undefined },
) satisfies typeof fetch
