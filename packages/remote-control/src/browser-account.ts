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
  const pendingKey = "miao.remote-control.logout-pending"
  const changed = (event: StorageEvent) => {
    if (event.key !== pendingKey && event.key !== null) return
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
    if (!response.ok) throw new Error("Relay account request could not be confirmed")
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
