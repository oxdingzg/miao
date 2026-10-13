export * as CredentialDaemon from "./daemon"

import { createConnection } from "node:net"
import { Schema } from "effect"
import { Credential } from "@miao/schema/credential"

/** Durable ownership marker, preserved by provider metadata and JSON rotation. */
export const socket = (value: Credential.Value) => {
  const path = value.metadata?.miaoCredentialSocket
  return typeof path === "string" && path.length > 0 ? path : undefined
}

/** One provider turn reads through its owner; the TS broker never refreshes it. */
export const get = (path: string, credentialID: string, integrationID: string) =>
  new Promise<Credential.Value>((resolve, reject) => {
    const connection = createConnection(path)
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error, value?: Credential.Value) => {
      if (settled) return
      settled = true
      connection.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }
    connection.setTimeout(40_000, () => finish(new Error("Credential daemon request timed out")))
    connection.once("error", () => finish(new Error("Credential daemon is unavailable")))
    connection.once("connect", () => {
      connection.write(
        JSON.stringify({ id: 1, op: "get", credential_id: credentialID, integration: integrationID }) + "\n",
      )
    })
    connection.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 256 * 1024) return finish(new Error("Credential daemon reply exceeded its bound"))
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const boundary = bytes.indexOf(10)
      if (boundary < 0) return
      const response = Schema.decodeUnknownExit(Schema.UnknownFromJsonString)(bytes.subarray(0, boundary).toString())
      if (response._tag === "Failure" || typeof response.value !== "object" || response.value === null)
        return finish(new Error("Invalid credential daemon reply"))
      const frame = response.value as Record<string, unknown>
      const payload = frame.ok
      if (frame.id !== 1 || typeof payload !== "object" || payload === null)
        return finish(new Error("Credential daemon rejected the request"))
      const ok = payload as Record<string, unknown>
      if (ok.integration !== integrationID) return finish(new Error("Credential daemon integration mismatch"))
      const credential = Schema.decodeUnknownExit(Credential.Value)(ok.credential)
      if (credential._tag === "Failure") return finish(new Error("Invalid daemon credential value"))
      finish(undefined, credential.value)
    })
    connection.once("close", () => {
      if (!settled) finish(new Error("Credential daemon disconnected before replying"))
    })
  })
