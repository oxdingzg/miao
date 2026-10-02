import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readAccounts } from "../src/accounts"
import type { Channel, Inbound } from "../src/channel"
import { createHost, PairedMessage, TestMessage, type FlowStep } from "../src/host"
import { eventually } from "../src/testing"
import { createEchoNetwork, echo, type EchoNetwork } from "./fixtures/echo-connector"

const owner = "owner-1"
const stranger = "stranger-9"

const fixture = {
  directory: "",
  network: undefined as EchoNetwork | undefined,
  now: 1_800_000_000_000,
}

beforeEach(async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), "remote-host-"))
  fixture.network = createEchoNetwork()
  fixture.now = 1_800_000_000_000
})

afterEach(async () => {
  await rm(fixture.directory, { recursive: true, force: true })
})

function network() {
  if (!fixture.network) throw new Error("network missing")
  return fixture.network
}

const authFile = () => path.join(fixture.directory, "remote-auth.json")

function host() {
  const service = network()
  return createHost({
    authFile: authFile(),
    stateDir: path.join(fixture.directory, "state"),
    connectors: [echo],
    options: () => ({ network: service }),
    agentVersion: "0.0.0-test",
    now: () => fixture.now,
  })
}

function sink() {
  const channels: Channel[] = []
  const received: Inbound[] = []
  return {
    channels,
    received,
    add: async (channel: Channel) => {
      channels.push(channel)
      await channel.start(async (message) => void received.push(message))
    },
    remove: async (id: string) => {
      const index = channels.findIndex((channel) => channel.id === id)
      if (index === -1) return
      await channels[index].stop()
      channels.splice(index, 1)
    },
  }
}

async function collect(steps: AsyncIterable<FlowStep>, onStep: (step: FlowStep) => void | Promise<void>) {
  const seen: FlowStep[] = []
  for await (const step of steps) {
    seen.push(step)
    await onStep(step)
  }
  return seen
}

describe("login flows and pairing", () => {
  test("a form login without an owner issues a pairing code; the first sender of the code becomes the owner", async () => {
    const remote = host()
    const target = sink()
    remote.bind(target)
    const flow = remote.login("echo")
    const steps = await collect(flow.events(), async (step) => {
      if (step.type === "form") {
        expect(step.fields[0]).toMatchObject({ key: "token", secret: true })
        expect(flow.input({ token: "abc" })).toBe(true)
      }
      if (step.type === "pair") {
        expect(step.code).toMatch(/^\d{6}$/)
        expect(step.link).toBe(`echo://bot-abc?start=${step.code}`)
        network().deliver({ from: stranger, text: "000000" === step.code ? "111111" : "000000", id: "w1" })
        network().deliver({ from: stranger, text: "hi", id: "w2" })
        network().deliver({ from: owner, text: `/start ${step.code}`, id: "p1" })
      }
    })
    expect(steps.map((step) => step.type)).toEqual(["form", "progress", "pair", "done"])
    expect(JSON.stringify(steps)).not.toContain('abc"}')
    expect(network().sent).toContainEqual({ to: owner, text: PairedMessage, reply: "p1" })

    const accounts = await readAccounts(authFile())
    expect(accounts.echo["bot-abc"]).toMatchObject({ owner, label: "Echo bot", credentials: { token: "abc" } })
    expect(accounts.echo["bot-abc"].pair).toBeUndefined()
    expect((await stat(authFile())).mode & 0o777).toBe(0o600)

    // After pairing only the owner reaches the router, and the pairing code is spent.
    network().deliver({ from: stranger, text: "let me in", id: "s1" })
    network().deliver({ from: owner, text: "hello", id: "o1" })
    await eventually(() => target.received.length === 1)
    expect(target.received[0]).toMatchObject({ user: owner, text: "hello" })
    expect(target.channels.map((channel) => channel.id)).toEqual(["echo/bot-abc"])
    expect(remote.allow("echo/bot-abc", owner)).toBe(true)
    expect(remote.allow("echo/bot-abc", stranger)).toBe(false)

    expect(await remote.test("echo", "bot-abc")).toMatchObject({ ok: true })
    expect(network().sent.at(-1)).toMatchObject({ to: owner, text: TestMessage })

    const [status] = await remote.status()
    expect(status).toMatchObject({ id: "echo", pairing: true })
    expect(status.accounts[0]).toMatchObject({ account: "bot-abc", state: "connecting", owner })
    await target.remove("echo/bot-abc")
  })

  test("re-pairing keeps the current owner until someone sends the new code; repeated wrong codes withdraw it", async () => {
    const remote = host()
    const target = sink()
    remote.bind(target)
    const flow = remote.login("echo")
    await collect(flow.events(), (step) => {
      if (step.type === "form") flow.input({ token: "t" })
      if (step.type === "pair") network().deliver({ from: owner, text: step.code, id: "pair-1" })
    })

    expect(await remote.pair("echo", "missing")).toEqual({ ok: false, unknown: true, message: "账号不存在" })
    const second = await pairCode(remote.pair("echo", "bot-t"))
    network().deliver({ from: owner, text: "still mine", id: "o2" })
    await eventually(() => target.received.some((message) => message.text === "still mine"))
    const wrong = second.code === "123456" ? "654321" : "123456"
    Array.from({ length: 10 }, (_, index) => network().deliver({ from: stranger, text: wrong, id: `x${index}` }))
    await eventually(async () => (await readAccounts(authFile())).echo["bot-t"].pair === undefined)
    network().deliver({ from: stranger, text: second.code, id: "late" })
    await Bun.sleep(30)
    expect((await readAccounts(authFile())).echo["bot-t"].owner).toBe(owner)

    const third = await pairCode(remote.pair("echo", "bot-t"))
    network().deliver({ from: stranger, text: third.code, id: "takeover" })
    await eventually(async () => (await readAccounts(authFile())).echo["bot-t"].owner === stranger)
    await target.remove("echo/bot-t")
  })

  test("an expired code is ignored, and without a router the host listens only for the code", async () => {
    const remote = host()
    const flow = remote.login("echo")
    const steps = await collect(flow.events(), (step) => {
      if (step.type === "form") flow.input({ token: "solo" })
      if (step.type !== "pair") return
      fixture.now += 11 * 60_000
      network().deliver({ from: owner, text: step.code, id: "too-late" })
      flow.cancel()
    })
    expect(steps.at(-1)?.type).toBe("error")
    expect((await readAccounts(authFile())).echo["bot-solo"].owner).toBeUndefined()
    expect(network().connected()).toBe(true)
    await remote.close()
    expect(network().connected()).toBe(false)
  })

  test("cancelling a login waiting for input ends it with an error and saves nothing", async () => {
    const remote = host()
    const flow = remote.login("echo")
    const steps = await collect(flow.events(), (step) => {
      if (step.type === "form") flow.cancel()
    })
    expect(steps.map((step) => step.type)).toEqual(["form", "error"])
    expect(flow.finished()).toBe(true)
    expect(flow.input({ token: "late" })).toBe(false)
    expect(await readAccounts(authFile())).toEqual({})
  })

  test("removing an account stops its channel and deletes its credentials", async () => {
    const remote = host()
    const target = sink()
    remote.bind(target)
    const flow = remote.login("echo")
    await collect(flow.events(), (step) => {
      if (step.type === "form") flow.input({ token: "gone" })
      if (step.type === "pair") network().deliver({ from: owner, text: step.code, id: "p" })
    })
    expect(await remote.remove("echo", "bot-gone")).toBe(true)
    expect(target.channels).toHaveLength(0)
    expect((await readAccounts(authFile())).echo).toEqual({})
    expect(await remote.remove("echo", "bot-gone")).toBe(false)
  })

  test("open builds channels for saved accounts and skips ones that need a new login", async () => {
    const first = host()
    first.bind(sink())
    const flow = first.login("echo")
    await collect(flow.events(), (step) => {
      if (step.type === "form") flow.input({ token: "keep" })
      if (step.type === "pair") network().deliver({ from: owner, text: step.code, id: "p" })
    })
    const second = host()
    const opened = await second.open()
    expect(opened.channels.map((channel) => channel.id)).toEqual(["echo/bot-keep"])
    expect(opened.failures).toEqual([])
  })
})

async function pairCode(result: ReturnType<ReturnType<typeof createHost>["pair"]>) {
  const settled = await result
  if (!settled.ok) throw new Error(settled.message)
  return settled.step
}
