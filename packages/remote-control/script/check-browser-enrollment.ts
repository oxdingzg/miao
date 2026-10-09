import { chromium } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { SecureChannel } from "../src/secure-channel"
import { DeviceRoster } from "../src/device-roster"
import type { BrowserEnrollment } from "../src/browser-enrollment"

declare global {
  interface Window {
    browserEnrollment: typeof BrowserEnrollment
  }
}
const root = await SecureChannel.createIdentity()
const host = await SecureChannel.createIdentity()
const member = await SecureChannel.createIdentity()
const accountID = "account_aaaaaaaaaaaaaaaaaaaaaaaa"
const binding = { hubURL: "https://relay.example.invalid", accountID, deviceKey: root.publicKey }
const first = await DeviceRoster.sign(root, {
  version: 1,
  accountID,
  sequence: 1,
  issuedAt: 0,
  devices: [{ publicKey: root.publicKey, label: "Root", signer: true, addedAt: 0 }],
})
const next = await DeviceRoster.sign(root, {
  ...first.roster,
  sequence: 2,
  devices: [...first.roster.devices, { publicKey: member.publicKey, label: "Phone", signer: false, addedAt: 0 }].sort(
    (a, b) => (a.publicKey < b.publicKey ? -1 : 1),
  ),
})
const fork = await DeviceRoster.sign(root, {
  ...next.roster,
  devices: next.roster.devices.map((device) => ({ ...device, label: device.label + "fork" })),
})
const state: BrowserEnrollment.State = {
  version: 1,
  ...binding,
  roster: first,
  digest: await DeviceRoster.fingerprint(first.roster),
  hosts: [{ hostID: "host_aaaaaaaaaaaaaaaaaaaaaaaa", publicKey: host.publicKey }],
}
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/browser-enrollment.ts", import.meta.url))],
  target: "browser",
})
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser enrollment bundle failed")
const source = await bundle.outputs[0].text()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/state.js"
      ? new Response(source, { headers: { "content-type": "text/javascript" } })
      : new Response(
          '<script type="module">import * as state from "/state.js";window.browserEnrollment=state</script>',
          { headers: { "content-type": "text/html" } },
        ),
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}`)
  await page.waitForFunction(() => typeof window.browserEnrollment?.open === "function")
  const result = await page.evaluate(
    async ({ binding, state, next, fork }) => {
      const api = window.browserEnrollment
      const store = api.open(binding, () => true)
      const rejects = async (action: () => Promise<unknown>) => {
        try {
          await action()
        } catch {
          return true
        }
        throw new Error("Invalid enrollment unexpectedly accepted")
      }
      if (await store.read()) throw new Error("Fixture storage was not isolated")
      const record = {
        accountID: binding.accountID,
        sequence: 1,
        payload: state.roster.roster,
        signature: state.roster.signature,
        digest: state.digest,
      }
      if (!(await api.snapshot({ roster: record }, binding.accountID))) throw new Error("Transport snapshot missing")
      await rejects(() => api.snapshot({ roster: record }, "account_bbbbbbbbbbbbbbbbbbbbbbbb"))
      await store.put(state)
      await rejects(() => store.put({ ...state, deviceKey: "wrong" }))
      await store.refresh(next)
      await rejects(() => store.refresh(fork))
      await rejects(() => store.refresh(state.roster))
      let authorized = true
      const fenced = api.open(binding, () => authorized)
      const saving = fenced.put((await store.read()) as typeof state)
      authorized = false
      await rejects(() => saving)
      const other = api.open({ ...binding, accountID: "account_bbbbbbbbbbbbbbbbbbbbbbbb" }, () => true)
      if (await other.read()) throw new Error("Cross-account trust leaked")
      const current = await store.read()
      if (current?.roster.roster.sequence !== 2 || current.hosts[0]?.publicKey !== state.hosts[0]?.publicKey)
        throw new Error("Rejected mutation changed durable trust")
      return { sequence: current.roster.roster.sequence, signerKeys: api.authority(current).signerKeys }
    },
    { binding, state, next, fork },
  )
  await page.reload()
  await page.waitForFunction(() => typeof window.browserEnrollment?.open === "function")
  const restored = await page.evaluate(
    async (binding) => (await window.browserEnrollment.open(binding, () => true).read())?.roster.roster.sequence,
    binding,
  )
  if (result.sequence !== 2 || restored !== 2 || JSON.stringify(result.signerKeys) !== JSON.stringify([root.publicKey]))
    throw new Error("Enrollment authority did not survive reload")
  console.log(
    "BROWSER_ENROLLMENT_PASS: atomic trust, reload, independent pins, account isolation, fork/rollback and authorization fence",
  )
} finally {
  await browser?.close()
  server.stop(true)
}
