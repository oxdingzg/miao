export * as BrowserCheckpoint from "./browser-checkpoint"

export type Scope = {
  hubURL: string; accountID: string; devicePublicKey: string; hostID: string; runtimeID: string
  grantID: string; grantVersion: number; sessionID: string
}
export type Checkpoint = { revision: number; cursor: number; state: string; updatedAt: number }

/** Commit a complete projected page and cursor together; fence concurrent tabs using a revision. */
export async function open(name = "miao.remote-control.checkpoints") {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore("checkpoints")
    request.onsuccess = () => {
      if (failed) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = request.onblocked = () => { failed = true; reject(new Error("Browser checkpoint storage unavailable")) }
  })
  function key(scope: Scope) {
    const url = new URL(scope.hubURL)
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        !/^[A-Za-z0-9_-]{87}$/.test(scope.devicePublicKey) || !Number.isSafeInteger(scope.grantVersion) || scope.grantVersion < 1 ||
        [scope.accountID, scope.hostID, scope.runtimeID, scope.grantID, scope.sessionID].some((value) => typeof value !== "string" || !value || value.length > 128))
      throw new Error("Invalid checkpoint scope")
    return JSON.stringify([url.origin, scope.accountID, scope.devicePublicKey, scope.hostID, scope.runtimeID,
      scope.grantID, scope.grantVersion, scope.sessionID])
  }
  return {
    close: () => database.close(),
    read: async (scope: Scope): Promise<Checkpoint | undefined> => {
      const address = key(scope)
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readonly")
        const request = transaction.objectStore("checkpoints").get(address)
        transaction.oncomplete = () => {
          try { resolve(request.result === undefined ? undefined : validate(request.result)) }
          catch { reject(new Error("Saved checkpoint is invalid")) }
        }
        transaction.onabort = transaction.onerror = () => reject(new Error("Checkpoint read failed"))
      })
    },
    commit: async (scope: Scope, page: { cursor: number; state: string }, expectedRevision: number): Promise<Checkpoint> => {
      const address = key(scope)
      const candidate = validate({ ...page, revision: expectedRevision + 1, updatedAt: Date.now() })
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid checkpoint revision")
      return new Promise((resolve, reject) => {
        let conflict = false
        const transaction = database.transaction("checkpoints", "readwrite")
        const store = transaction.objectStore("checkpoints")
        const request = store.get(address)
        request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? undefined : validate(request.result)
            if ((previous?.revision ?? 0) !== expectedRevision || candidate.cursor < (previous?.cursor ?? 0)) {
              conflict = true; transaction.abort(); return
            }
            store.put(candidate, address)
          } catch { transaction.abort() }
        }
        transaction.oncomplete = () => resolve(candidate)
        transaction.onabort = transaction.onerror = () => reject(new Error(conflict ? "Checkpoint changed; reload before applying the page" : "Checkpoint commit failed"))
      })
    },
  }
}

function validate(value: unknown): Checkpoint {
  if (typeof value !== "object" || value === null || !("revision" in value) || !("cursor" in value) ||
      !("state" in value) || !("updatedAt" in value) || typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.cursor !== "number" ||
      !Number.isSafeInteger(value.cursor) || value.cursor < 0 || typeof value.updatedAt !== "number" ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || typeof value.state !== "string" ||
      new TextEncoder().encode(value.state).length > 8 * 1024 * 1024) throw new Error("Invalid checkpoint")
  JSON.parse(value.state)
  return { revision: value.revision, cursor: value.cursor, state: value.state, updatedAt: value.updatedAt }
}
