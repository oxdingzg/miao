export * as LSPClient from "./client"

import type { Readable, Writable } from "node:stream"

export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

/** Minimal LSP diagnostic shape captured from `textDocument/publishDiagnostics`. */
export interface Diagnostic {
  readonly range: Range
  readonly severity?: number
  readonly code?: string | number
  readonly source?: string
  readonly message: string
}

/** The process surface the client needs, kept structural so tests can supply fakes. */
export interface Transport {
  readonly stdin: Writable
  readonly stdout: Readable
  kill(): void
  onExit(listener: () => void): void
}

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }

/**
 * JSON-RPC 2.0 client over LSP base-protocol framing. The transport is any
 * duplex child process; the client owns request correlation and notification
 * dispatch and is independent of how the process was started.
 */
export class Connection {
  private readonly pending = new Map<number, Pending>()
  private readonly notifications = new Map<string, (params: unknown) => void>()
  private buffer = Buffer.alloc(0)
  private nextID = 1
  private exited = false

  constructor(private readonly transport: Transport) {
    transport.stdout.on("data", (chunk: Buffer) => this.onData(chunk))
    transport.onExit(() => this.onExit())
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifications.set(method, handler)
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("LSP connection closed"))
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return
    this.send({ jsonrpc: "2.0", method, params })
  }

  close(): void {
    this.exited = true
    for (const { reject } of this.pending.values()) reject(new Error("LSP connection closed"))
    this.pending.clear()
    this.transport.kill()
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message)
    this.transport.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString("utf8")
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.dispatch(JSON.parse(body))
      } catch {
        // Ignore malformed frames; a subsequent well-formed frame still works.
      }
    }
  }

  private dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null) return
    const record = message as Record<string, unknown>
    if (record.id !== undefined && (record.result !== undefined || record.error !== undefined)) {
      const pending = this.pending.get(record.id as number)
      if (!pending) return
      this.pending.delete(record.id as number)
      if (record.error !== undefined) pending.reject(record.error)
      else pending.resolve(record.result)
      return
    }
    if (typeof record.method === "string") this.notifications.get(record.method)?.(record.params)
  }

  private onExit(): void {
    this.exited = true
    for (const { reject } of this.pending.values()) reject(new Error("LSP process exited"))
    this.pending.clear()
  }
}

export const fileURI = (file: string) => `file://${file}`
