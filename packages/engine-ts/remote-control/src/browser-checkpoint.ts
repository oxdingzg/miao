export * as BrowserCheckpoint from "./browser-checkpoint"

import type { ControlAgent } from "./agent"
import { RemoteRPC } from "./remote-rpc"

export type Scope = {
  hubURL: string
  accountID: string
  devicePublicKey: string
  hostID: string
  runtimeID: string
  grantID: string
  grantVersion: number
  sessionID: string
}
export type Checkpoint = { revision: number; cursor: number; state: string; updatedAt: number }
export type Draft = { revision: number; text: string; updatedAt: number }
export type OperationStatus =
  | "prepared"
  | "awaitingConfirmation"
  | "outcomeUnknown"
  | "accepted"
  | "completed"
  | "rejected"
  | "expired"
export type Operation = {
  id: string
  method: ControlAgent.Method
  payload: string
  status: OperationStatus
  revision: number
  createdAt: number
  result?: string
}

/** Commit a complete projected page and cursor together; fence concurrent tabs using a revision. */
export async function open(name = "miao.remote-control.checkpoints") {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore("checkpoints")
    request.onsuccess = () => {
      if (failed) {
        request.result.close()
        return
      }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = request.onblocked = () => {
      failed = true
      reject(new Error("Browser checkpoint storage unavailable"))
    }
  })
  function key(scope: Scope) {
    const url = new URL(scope.hubURL)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      !/^[A-Za-z0-9_-]{87}$/.test(scope.devicePublicKey) ||
      !Number.isSafeInteger(scope.grantVersion) ||
      scope.grantVersion < 1 ||
      [scope.accountID, scope.hostID, scope.runtimeID, scope.grantID, scope.sessionID].some(
        (value) => typeof value !== "string" || !value || value.length > 128,
      )
    )
      throw new Error("Invalid checkpoint scope")
    return JSON.stringify([
      url.origin,
      scope.accountID,
      scope.devicePublicKey,
      scope.hostID,
      scope.runtimeID,
      scope.grantID,
      scope.grantVersion,
      scope.sessionID,
    ])
  }
  return {
    close: () => database.close(),
    readDraft: async (scope: Scope): Promise<Draft | undefined> => {
      const address = key(scope).slice(0, -1) + ',"draft"]'
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readonly")
        const request = transaction.objectStore("checkpoints").get(address)
        transaction.oncomplete = () => {
          try {
            resolve(request.result === undefined ? undefined : validateDraft(request.result))
          } catch {
            reject(new Error("Saved draft is invalid"))
          }
        }
        transaction.onabort = transaction.onerror = () => reject(new Error("Draft could not be read"))
      })
    },
    saveDraft: async (scope: Scope, text: string, expectedRevision: number): Promise<Draft> => {
      const address = key(scope).slice(0, -1) + ',"draft"]'
      const draft = validateDraft({ text, revision: expectedRevision + 1, updatedAt: Date.now() })
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid draft revision")
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readwrite")
        const store = transaction.objectStore("checkpoints")
        const request = store.get(address)
        request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? undefined : validateDraft(request.result)
            if ((previous?.revision ?? 0) !== expectedRevision) throw new Error()
            store.put(draft, address)
          } catch {
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(draft)
        transaction.onabort = transaction.onerror = () => reject(new Error("Draft changed; reload before saving"))
      })
    },
    prepareOperation: async (
      scope: Scope,
      input: { id: string; method: ControlAgent.Method; payload: string },
    ): Promise<Operation> => {
      const scopeKey = key(scope)
      const address = operationKey(scopeKey, input.id)
      const candidate = validateOperation({ ...input, status: "prepared", revision: 1, createdAt: Date.now() })
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readwrite")
        const store = transaction.objectStore("checkpoints")
        const request = store.get(address)
        let selected = candidate
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              selected = validateOperation(request.result)
              if (selected.method !== candidate.method || selected.payload !== candidate.payload) throw new Error()
            } else {
              const prefix = scopeKey.slice(0, -1) + ',"operation",'
              const range = IDBKeyRange.bound(prefix, prefix + "\uffff")
              const countRequest = store.count(range)
              countRequest.onsuccess = () => {
                if (countRequest.result < 256) {
                  store.add(candidate, address)
                  return
                }
                if (countRequest.result > 256) {
                  transaction.abort()
                  return
                }
                const scan = store.openCursor(range)
                let count = 0
                let oldest: { key: IDBValidKey; createdAt: number } | undefined
                scan.onsuccess = () => {
                  try {
                    const row = scan.result
                    if (row) {
                      const existing = validateOperation(row.value)
                      count++
                      if (
                        ["completed", "rejected", "expired"].includes(existing.status) &&
                        (!oldest || existing.createdAt < oldest.createdAt)
                      )
                        oldest = { key: row.key, createdAt: existing.createdAt }
                      row.continue()
                      return
                    }
                    if (count >= 256) {
                      if (!oldest || count > 256) throw new Error()
                      store.delete(oldest.key)
                    }
                    store.add(candidate, address)
                  } catch {
                    transaction.abort()
                  }
                }
              }
            }
          } catch {
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(selected)
        transaction.onabort = transaction.onerror = () =>
          reject(new Error("Operation could not be prepared or its immutable payload changed"))
      })
    },
    operations: async (scope: Scope): Promise<Operation[]> => {
      const prefix = key(scope).slice(0, -1) + ',"operation",'
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readonly")
        const request = transaction.objectStore("checkpoints").openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"))
        const values: Operation[] = []
        request.onsuccess = () => {
          const row = request.result
          if (!row) return
          try {
            if (values.length >= 256) throw new Error()
            values.push(validateOperation(row.value))
            row.continue()
          } catch {
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(values)
        transaction.onabort = transaction.onerror = () => reject(new Error("Operation records could not be read"))
      })
    },
    transitionOperation: async (
      scope: Scope,
      id: string,
      expectedRevision: number,
      status: Exclude<OperationStatus, "prepared">,
      result?: string,
    ): Promise<Operation> => {
      const address = operationKey(key(scope), id)
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readwrite")
        const store = transaction.objectStore("checkpoints")
        const request = store.get(address)
        let updated: Operation
        request.onsuccess = () => {
          try {
            const previous = validateOperation(request.result)
            if (previous.revision !== expectedRevision || !transitions[previous.status].includes(status))
              throw new Error()
            updated = validateOperation({
              ...previous,
              revision: previous.revision + 1,
              status,
              result: result ?? previous.result,
            })
            store.put(updated, address)
          } catch {
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(updated)
        transaction.onabort = transaction.onerror = () =>
          reject(new Error("Operation changed or its transition is invalid"))
      })
    },
    /** Close the account transport and stop projection before clearing its cached pages. */
    clearAccount: async (hubURL: string, accountID: string): Promise<void> => {
      const url = new URL(hubURL)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !["https:", "http:"].includes(url.protocol) ||
        !accountID ||
        accountID.length > 128
      )
        throw new Error("Invalid checkpoint account")
      const prefix = JSON.stringify([url.origin, accountID]).slice(0, -1) + ","
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readwrite")
        const cursor = transaction.objectStore("checkpoints").openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          if (typeof row.key === "string" && row.key.startsWith(prefix)) row.delete()
          row.continue()
        }
        transaction.oncomplete = () => resolve()
        transaction.onabort = transaction.onerror = () => reject(new Error("Account checkpoint cleanup failed"))
      })
    },
    read: async (scope: Scope): Promise<Checkpoint | undefined> => {
      const address = key(scope)
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("checkpoints", "readonly")
        const request = transaction.objectStore("checkpoints").get(address)
        transaction.oncomplete = () => {
          try {
            resolve(request.result === undefined ? undefined : validate(request.result))
          } catch {
            reject(new Error("Saved checkpoint is invalid"))
          }
        }
        transaction.onabort = transaction.onerror = () => reject(new Error("Checkpoint read failed"))
      })
    },
    commit: async (
      scope: Scope,
      page: { cursor: number; state: string },
      expectedRevision: number,
    ): Promise<Checkpoint> => {
      const address = key(scope)
      const candidate = validate({ ...page, revision: expectedRevision + 1, updatedAt: Date.now() })
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error("Invalid checkpoint revision")
      return new Promise((resolve, reject) => {
        let conflict = false
        const transaction = database.transaction("checkpoints", "readwrite")
        const store = transaction.objectStore("checkpoints")
        const request = store.get(address)
        request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? undefined : validate(request.result)
            if ((previous?.revision ?? 0) !== expectedRevision || candidate.cursor < (previous?.cursor ?? 0)) {
              conflict = true
              transaction.abort()
              return
            }
            store.put(candidate, address)
          } catch {
            transaction.abort()
          }
        }
        transaction.oncomplete = () => resolve(candidate)
        transaction.onabort = transaction.onerror = () =>
          reject(
            new Error(conflict ? "Checkpoint changed; reload before applying the page" : "Checkpoint commit failed"),
          )
      })
    },
  }
}

function validate(value: unknown): Checkpoint {
  if (
    typeof value !== "object" ||
    value === null ||
    !("revision" in value) ||
    !("cursor" in value) ||
    !("state" in value) ||
    !("updatedAt" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0 ||
    typeof value.state !== "string" ||
    new TextEncoder().encode(value.state).length > 8 * 1024 * 1024
  )
    throw new Error("Invalid checkpoint")
  JSON.parse(value.state)
  return { revision: value.revision, cursor: value.cursor, state: value.state, updatedAt: value.updatedAt }
}

function validateDraft(value: unknown): Draft {
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    new TextEncoder().encode(value.text).length > 64 * 1024 ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "number" ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  )
    throw new Error("Invalid draft")
  return { text: value.text, revision: value.revision, updatedAt: value.updatedAt }
}

const transitions: Record<OperationStatus, readonly OperationStatus[]> = {
  prepared: ["awaitingConfirmation", "rejected", "expired"],
  awaitingConfirmation: ["outcomeUnknown", "accepted", "completed", "rejected", "expired"],
  outcomeUnknown: ["outcomeUnknown", "accepted", "completed", "rejected", "expired"],
  accepted: ["accepted", "completed"],
  completed: ["completed"],
  rejected: ["rejected"],
  expired: ["expired"],
}
function operationKey(scope: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
    throw new Error("Invalid operation ID")
  return scope.slice(0, -1) + ',"operation",' + JSON.stringify(id) + "]"
}
function validateOperation(value: unknown): Operation {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !RemoteRPC.isWrite(value.method) ||
    !("payload" in value) ||
    typeof value.payload !== "string" ||
    new TextEncoder().encode(value.payload).length > 64 * 1024 ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !Object.hasOwn(transitions, value.status) ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    throw new Error("Invalid operation record")
  operationKey("[]", value.id)
  JSON.parse(value.payload)
  let result: string | undefined
  if ("result" in value && value.result !== undefined) {
    if (typeof value.result !== "string" || new TextEncoder().encode(value.result).length > 64 * 1024)
      throw new Error("Invalid operation result")
    JSON.parse(value.result)
    result = value.result
  }
  return {
    id: value.id,
    method: value.method,
    payload: value.payload,
    status: value.status as OperationStatus,
    revision: value.revision,
    createdAt: value.createdAt,
    ...(result === undefined ? {} : { result }),
  }
}
