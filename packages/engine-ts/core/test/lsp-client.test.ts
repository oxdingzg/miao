import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { LSPClient } from "@miao/core/lsp/client"

const frame = (message: unknown) => {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

const parse = (chunk: Buffer) => {
  const text = chunk.toString("utf8")
  const headerEnd = text.indexOf("\r\n\r\n")
  const length = Number(/Content-Length:\s*(\d+)/i.exec(text.slice(0, headerEnd))?.[1])
  return JSON.parse(text.slice(headerEnd + 4, headerEnd + 4 + length)) as Record<string, unknown>
}

const makeTransport = () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const exitListeners: Array<() => void> = []
  let killed = false
  const transport: LSPClient.Transport = {
    stdin,
    stdout,
    kill: () => {
      killed = true
    },
    onExit: (listener) => exitListeners.push(listener),
  }
  return { transport, stdin, stdout, exit: () => exitListeners.forEach((listener) => listener()), killed: () => killed }
}

describe("LSPClient.Connection", () => {
  test("correlates a JSON-RPC response to its request", async () => {
    const { transport, stdin, stdout } = makeTransport()
    const connection = new LSPClient.Connection(transport)

    const written = new Promise<Buffer>((resolve) => stdin.once("data", (chunk: Buffer) => resolve(chunk)))
    const pending = connection.request("initialize", { processId: 1 })
    const request = parse(await written)
    expect(request.method).toBe("initialize")
    expect(request.jsonrpc).toBe("2.0")

    stdout.write(frame({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }))
    expect(await pending).toEqual({ capabilities: {} })
  })

  test("dispatches server notifications", async () => {
    const { transport, stdout } = makeTransport()
    const connection = new LSPClient.Connection(transport)
    const received: unknown[] = []
    connection.onNotification("textDocument/publishDiagnostics", (params) => received.push(params))

    stdout.write(frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file://a" } }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(received).toEqual([{ uri: "file://a" }])
  })

  test("rejects pending requests when the process exits", async () => {
    const { transport, stdout, exit } = makeTransport()
    const connection = new LSPClient.Connection(transport)
    const pending = connection.request("initialize", {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    exit()
    await expect(pending).rejects.toThrow()
    void stdout
  })

  test("rejects a request that exceeds its timeout and keeps the connection usable", async () => {
    const { transport, stdin, stdout } = makeTransport()
    const connection = new LSPClient.Connection(transport)

    const firstWritten = new Promise<Buffer>((resolve) => stdin.once("data", (chunk: Buffer) => resolve(chunk)))
    const timedOut = connection.request("textDocument/hover", {}, { timeoutMs: 20 })
    const first = parse(await firstWritten)
    await expect(timedOut).rejects.toThrow("LSP request timed out after 20ms: textDocument/hover")

    // A response that arrives after the timeout is dropped rather than reviving
    // the settled request, and the next request still correlates normally.
    stdout.write(frame({ jsonrpc: "2.0", id: first.id, result: { contents: "late" } }))
    const secondWritten = new Promise<Buffer>((resolve) => stdin.once("data", (chunk: Buffer) => resolve(chunk)))
    const next = connection.request("textDocument/hover", {}, { timeoutMs: 200 })
    const second = parse(await secondWritten)
    stdout.write(frame({ jsonrpc: "2.0", id: second.id, result: { contents: "on time" } }))
    expect(await next).toEqual({ contents: "on time" })
  })
})
