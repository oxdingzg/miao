// Minimal LSP server for tests: answers initialize and publishes one error diagnostic per opened document.
const send = (message: unknown) => {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString("ascii")
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString("utf8")
    buffer = buffer.subarray(start + length)
    const message = JSON.parse(body) as { id?: number; method?: string; params?: any }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })
    } else if (message.method === "textDocument/didOpen") {
      const uri = message.params.textDocument.uri as string
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: "MOCK_ERROR",
            },
          ],
        },
      })
    }
  }
})
