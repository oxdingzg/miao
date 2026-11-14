export * as BrowserIdentity from "./browser-identity"

import { SecureChannel } from "./secure-channel"

/** Store the non-exportable CryptoKey by structured clone, never as plaintext key material. */
export async function load(name = "miao.remote-control.device"): Promise<SecureChannel.Identity> {
  const database = await open(name)
  try {
    const stored = await read(database)
    if (stored !== undefined) return validate(stored)
    const candidate = await SecureChannel.createIdentity({ extractable: false })
    // Another tab may have created its identity during key generation. Select under a write transaction.
    return await new Promise<SecureChannel.Identity>((resolve, reject) => {
      const transaction = database.transaction("identity", "readwrite")
      const store = transaction.objectStore("identity")
      const request = store.get("device")
      let selected: SecureChannel.Identity
      request.onsuccess = () => {
        try {
          selected = request.result === undefined ? candidate : validate(request.result)
          if (request.result === undefined) store.add(candidate, "device")
        } catch { transaction.abort() }
      }
      transaction.oncomplete = () => resolve(selected)
      transaction.onabort = transaction.onerror = () => reject(new Error("Browser device identity could not be saved"))
    })
  } finally { database.close() }
}

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let failed = false
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore("identity")
    request.onsuccess = () => {
      if (failed) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close(); resolve(request.result)
    }
    request.onerror = request.onblocked = () => { failed = true; reject(new Error("Browser device storage is unavailable")) }
  })
}

function read(database: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("identity", "readonly")
    const request = transaction.objectStore("identity").get("device")
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = transaction.onerror = () => reject(new Error("Browser device identity could not be read"))
  })
}

function validate(value: unknown): SecureChannel.Identity {
  if (typeof value !== "object" || value === null || !("keys" in value) || !("publicKey" in value) ||
      typeof value.publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey) ||
      typeof value.keys !== "object" || value.keys === null || !("privateKey" in value.keys) || !("publicKey" in value.keys) ||
      !(value.keys.privateKey instanceof CryptoKey) || !(value.keys.publicKey instanceof CryptoKey) ||
      value.keys.privateKey.extractable || value.keys.privateKey.type !== "private" ||
      value.keys.privateKey.algorithm.name !== "ECDSA" || !value.keys.privateKey.usages.includes("sign") ||
      value.keys.publicKey.type !== "public" || value.keys.publicKey.algorithm.name !== "ECDSA")
    throw new Error("Browser device identity is invalid; existing grants require explicit re-pairing")
  return { publicKey: value.publicKey, keys: { privateKey: value.keys.privateKey, publicKey: value.keys.publicKey } }
}
