export * as BrowserAccount from "./browser-account"

export type Session = { accountID: string }

/** The web client uses same-origin HttpOnly session cookies; access JWTs exist only in this closure. */
export function make(options: { onInvalidated?: () => void } = {}) {
  let epoch = 0
  let account: Session | undefined
  let access: string | undefined
  let mutations: Promise<unknown> = Promise.resolve()
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const locked = async () => await navigator.locks.request("miao.remote-control.account", action)
    const result = mutations.then(locked, locked)
    mutations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const attemptKey = "miao.remote-control.login-attempt"
  const pendingKey = "miao.remote-control.logout-pending"
  const changed = (event: StorageEvent) => {
    if (event.key !== pendingKey && event.key !== attemptKey && event.key !== null) return
    epoch++
    account = undefined
    access = undefined
    options.onInvalidated?.()
  }
  window.addEventListener("storage", changed)
  const request = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok && !(path === "/api/auth/sign-out" && response.status === 401))
      throw new Error("Relay account request could not be confirmed")
    return response
  }
  const restore = async () => {
    if (localStorage.getItem(pendingKey)) return undefined
    const current = epoch
    const value: unknown = await (await request("/api/auth/get-session")).json()
    if (current !== epoch) throw new Error("Account changed")
    if (value === null) {
      account = undefined
      access = undefined
      return undefined
    }
    if (
      !object(value) ||
      !object(value.user) ||
      typeof value.user.id !== "string" ||
      !value.user.id ||
      value.user.id.length > 128
    )
      throw new Error("Invalid account session")
    account = { accountID: value.user.id }
    return { ...account }
  }
  const signOut = async () => {
    sessionStorage.removeItem("miao.remote-control.oauth")
    localStorage.removeItem(attemptKey)
    epoch++
    account = undefined
    access = undefined
    options.onInvalidated?.()
    localStorage.setItem(pendingKey, "1")
    const current = epoch
    return serialize(async () => {
      await request("/api/auth/sign-out", {})
      if (current === epoch) localStorage.removeItem(pendingKey)
    })
  }
  const bearer = async () => {
    if (!account || localStorage.getItem(pendingKey)) throw new Error("Account login required")
    const current = epoch
    // Refresh from the HttpOnly cookie before each directory/ticket request. No JWT is persisted.
    const value: unknown = await (await request("/api/auth/token")).json()
    if (current !== epoch || !account || localStorage.getItem(pendingKey)) throw new Error("Account changed")
    if (!object(value) || typeof value.token !== "string" || value.token.length > 8192 || !value.token)
      throw new Error("Invalid account access response")
    access = value.token
    return access
  }
  return {
    session: () => (account ? { ...account } : undefined),
    revocationPending: () => localStorage.getItem(pendingKey) !== null,
    restore,
    signOut,
    dispose: () => window.removeEventListener("storage", changed),
    signIn: async (email: string, password: string) => {
      const current = ++epoch
      account = undefined
      access = undefined
      localStorage.setItem(pendingKey, "1")
      options.onInvalidated?.()
      return serialize(async () => {
        if (current !== epoch) throw new Error("Account changed")
        if (localStorage.getItem(pendingKey)) {
          await request("/api/auth/sign-out", {})
          if (current !== epoch) throw new Error("Account changed")
          localStorage.removeItem(pendingKey)
        }
        await request("/api/auth/sign-in/email", { email, password })
        if (current !== epoch) throw new Error("Account changed")
        return restore()
      })
    },
    providers: async (): Promise<string[]> => {
      const response = await fetch("/api/auth/providers", {
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      })
      if (response.status === 404) return []
      if (!response.ok) throw new Error("Hub login methods could not be discovered")
      const value: unknown = await response.json()
      if (
        !object(value) ||
        !Array.isArray(value.providers) ||
        value.providers.some((provider) => typeof provider !== "string")
      )
        throw new Error("Invalid Hub login methods")
      return value.providers.filter((provider) => provider === "github" || provider === "google")
    },
    beginSocial: async (provider: string): Promise<string> => {
      if (provider !== "github" && provider !== "google") throw new Error("Unsupported login method")
      sessionStorage.removeItem("miao.remote-control.oauth")
      localStorage.removeItem(attemptKey)
      const current = ++epoch
      account = undefined
      access = undefined
      localStorage.setItem(pendingKey, "1")
      options.onInvalidated?.()
      return serialize(async () => {
        await request("/api/auth/sign-out", {})
        if (current !== epoch) throw new Error("Account changed")
        const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")
        const callbackURL = new URL(location.pathname, location.origin)
        callbackURL.searchParams.set("miao_login", "1")
        const value: unknown = await (
          await request("/api/auth/sign-in/social", { provider, callbackURL: callbackURL.href, state })
        ).json()
        if (current !== epoch) throw new Error("Account changed")
        if (!object(value) || typeof value.url !== "string") throw new Error("Invalid Hub authorization URL")
        const url = new URL(value.url)
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid Hub authorization URL")
        localStorage.setItem(attemptKey, state)
        sessionStorage.setItem("miao.remote-control.oauth", JSON.stringify({ state, startedAt: Date.now() }))
        return url.href
      })
    },
    completeSocial: async (search: string): Promise<Session | undefined> => {
      const params = new URLSearchParams(search)
      const saved = sessionStorage.getItem("miao.remote-control.oauth")
      sessionStorage.removeItem("miao.remote-control.oauth")
      const expected: unknown = saved ? JSON.parse(saved) : undefined
      if (
        !object(expected) ||
        typeof expected.state !== "string" ||
        typeof expected.startedAt !== "number" ||
        Date.now() - expected.startedAt < 0 ||
        Date.now() - expected.startedAt > 600000 ||
        params.get("miao_login") !== "1" ||
        params.get("state") !== expected.state ||
        localStorage.getItem(attemptKey) !== expected.state
      )
        throw new Error("Hub login callback could not be confirmed; start login again")
      localStorage.removeItem(attemptKey)
      if (params.has("error")) throw new Error("Hub authorization was not completed")
      const code = params.get("code")
      if (!code || code.length > 8192) throw new Error("Hub login callback could not be confirmed")
      const current = ++epoch
      account = undefined
      access = undefined
      return serialize(async () => {
        if (current !== epoch) throw new Error("Account changed")
        const response = await request("/api/auth/exchange", { code, client: "web" })
        await response.body?.cancel()
        if (current !== epoch) throw new Error("Account changed")
        localStorage.removeItem(pendingKey)
        const restored = await restore()
        if (!restored) throw new Error("Hub did not establish a browser session")
        return restored
      })
    },
    directory: async (): Promise<unknown> => {
      const current = epoch
      const response = await request("/api/hub/hosts", undefined, await bearer())
      const value: unknown = await response.json()
      if (current !== epoch) throw new Error("Account changed")
      return value
    },
    ticket: async (hostID: string, runtimeID: string): Promise<string> => {
      const current = epoch
      const value: unknown = await (await request("/api/hub/tickets", { hostID, runtimeID }, await bearer())).json()
      if (current !== epoch) throw new Error("Account changed")
      if (
        !object(value) ||
        typeof value.ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt <= Date.now()
      )
        throw new Error("Invalid account ticket")
      return value.ticket
    },
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
