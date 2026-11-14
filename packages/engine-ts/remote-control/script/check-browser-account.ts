import { chromium } from "@playwright/test"
import { Database } from "bun:sqlite"
import { fileURLToPath } from "node:url"
import { HubService } from "../src/hub-service"
import type { BrowserAccount } from "../src/browser-account"

declare global {
  interface Window {
    makeAccount: typeof BrowserAccount.make
    observedAccount: ReturnType<typeof BrowserAccount.make>
    accountInvalidated: boolean
  }
}

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/browser-account.ts", import.meta.url))],
  target: "browser",
})
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser account bundle failed")
const source = await bundle.outputs[0].text()
let backend: Awaited<ReturnType<typeof HubService.listen>> | undefined
let delayLogin = false
let denyLogout = false
let oauthExchanges = 0
let providerStatus = 200
const frontend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/auth/providers")
      return Response.json({ providers: ["github", "google"] }, { status: providerStatus })
    if (url.pathname === "/api/auth/sign-in/social") {
      const value = (await request.json()) as { state: string; callbackURL: string }
      if (new URL(value.callbackURL).searchParams.get("miao_login") !== "1")
        throw new Error("Missing browser callback marker")
      return Response.json({ url: "https://identity.example.invalid/authorize?state=" + value.state })
    }
    if (url.pathname === "/api/auth/exchange") {
      const value = (await request.json()) as { code: string; client: string }
      if (value.code !== "fixture-one-time-code" || value.client !== "web" || !backend)
        return new Response(null, { status: 401 })
      oauthExchanges++
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      const exchanged = await fetch(`http://127.0.0.1:${backend.port}/api/auth/sign-in/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "owner@example.invalid", password: "browser-account-fixture-password" }),
      })
      return exchanged
    }
    if (url.pathname.startsWith("/api/")) {
      if (!backend) return new Response(null, { status: 503 })
      if (denyLogout && url.pathname === "/api/auth/sign-out") return new Response(null, { status: 503 })
      if (delayLogin && url.pathname === "/api/auth/sign-in/email") await Bun.sleep(250)
      return fetch(new Request(`http://127.0.0.1:${backend.port}${url.pathname}`, request))
    }
    if (url.pathname === "/account.js") return new Response(source, { headers: { "content-type": "text/javascript" } })
    return new Response('<script type="module">import {make} from "/account.js";window.makeAccount=make</script>', {
      headers: { "content-type": "text/html" },
    })
  },
})
const database = new Database(":memory:")
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  backend = await HubService.listen({
    database,
    baseURL: `http://127.0.0.1:${frontend.port}`,
    secret: "browser-account-fixture-secret-000000000000000000",
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    bootstrap: { name: "Browser owner", email: "owner@example.invalid", password: "browser-account-fixture-password" },
  })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${frontend.port}`)
  await page.waitForFunction(() => typeof window.makeAccount === "function")
  const result = await page.evaluate(async () => {
    const account = window.makeAccount()
    const initial = await account.restore()
    const session = await account.signIn("owner@example.invalid", "browser-account-fixture-password")
    const directory = await account.directory()
    const restored = await window.makeAccount().restore()
    const cookies = document.cookie
    const stored = Object.keys(localStorage)
    await account.signOut()
    const after = await window.makeAccount().restore()
    const denied = await Promise.allSettled([account.directory()])
    return {
      initial: initial === undefined,
      login: !!session?.accountID,
      directory: typeof directory === "object" && directory !== null && "data" in directory,
      restored: restored?.accountID === session?.accountID,
      private: cookies === "" && stored.length === 0,
      logout: after === undefined && !account.session() && !account.revocationPending(),
      denied: denied[0]?.status === "rejected",
    }
  })
  if (Object.values(result).some((value) => !value)) throw new Error("Browser account lifecycle failed")
  delayLogin = true
  const race = await page.evaluate(async () => {
    const account = window.makeAccount()
    const login = account.signIn("owner@example.invalid", "browser-account-fixture-password").catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await account.signOut()
    await login
    return !account.session() && !account.revocationPending() && (await window.makeAccount().restore()) === undefined
  })
  if (!race) throw new Error("Browser logout did not fence delayed login")
  delayLogin = false
  await page.evaluate(() => window.makeAccount().signIn("owner@example.invalid", "browser-account-fixture-password"))
  const observer = await page.context().newPage()
  await observer.goto(`http://127.0.0.1:${frontend.port}`)
  await observer.waitForFunction(() => typeof window.makeAccount === "function")
  await observer.evaluate(async () => {
    window.accountInvalidated = false
    window.observedAccount = window.makeAccount({
      onInvalidated: () => {
        window.accountInvalidated = true
      },
    })
    if (!(await window.observedAccount.restore())) throw new Error("Other tab did not restore account")
  })
  denyLogout = true
  const pending = await page.evaluate(async () => {
    const account = window.makeAccount()
    await account.restore()
    await account.signOut().catch(() => undefined)
    return account.revocationPending() && !account.session() && (await window.makeAccount().restore()) === undefined
  })
  await observer.waitForFunction(() => window.accountInvalidated && !window.observedAccount.session())
  if (!pending) throw new Error("Unconfirmed logout allowed account restoration")
  denyLogout = false
  await page.evaluate(() => window.makeAccount().signOut())
  if (await observer.evaluate(() => window.makeAccount().restore())) throw new Error("Logout retry retained session")
  await observer.close()
  // Isolate social callback assertions from the preceding fixture rate-limit window.
  database.exec('DELETE FROM "rateLimit"')
  const social = await page.evaluate(async () => {
    const account = window.makeAccount()
    const providers = await account.providers()
    const url = await account.beginSocial("github")
    const rejected = await account.completeSocial("?miao_login=1&code=fixture-one-time-code&state=wrong").then(
      () => false,
      () => true,
    )
    const second = await account.beginSocial("google")
    const state = new URL(second).searchParams.get("state")
    const session = await account.completeSocial("?miao_login=1&code=fixture-one-time-code&state=" + state)
    const restored = await window.makeAccount().restore()
    const privateSession =
      document.cookie === "" &&
      !sessionStorage.getItem("miao.remote-control.oauth") &&
      !Object.keys(localStorage).some((key) => /token|jwt|oauth/.test(key))
    await account.signOut()
    return {
      providers: providers.join(",") === "github,google",
      start: new URL(url).protocol === "https:",
      rejected,
      session: !!session?.accountID && restored?.accountID === session.accountID,
      privateSession,
    }
  })
  if (Object.values(social).some((value) => !value) || oauthExchanges !== 1)
    throw new Error("Browser OAuth callback fencing failed")
  providerStatus = 502
  const discoveryFailed = await page.evaluate(() =>
    window
      .makeAccount()
      .providers()
      .then(
        () => false,
        () => true,
      ),
  )
  if (!discoveryFailed) throw new Error("Provider discovery silently downgraded login")
  providerStatus = 404
  if (await page.evaluate(async () => (await window.makeAccount().providers()).length))
    throw new Error("Legacy password Hub discovery failed")
  console.log("Browser account: real Hub cookie login, directory, restore, logout and delayed login fencing passed")
} finally {
  await browser?.close()
  frontend.stop(true)
  backend?.stop()
  database.close()
}
