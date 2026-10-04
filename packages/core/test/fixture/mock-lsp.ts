// Minimal LSP server for tests: answers initialize and publishes one error diagnostic per opened document.
// `--exit-before-initialize` models a real server crashing on startup, which used to
// take down any tool that merely touched a file. `--exit-on-request` models one that
// survives the handshake and then dies before answering a navigation request.
const flags = process.argv.slice(2)
if (flags.includes("--exit-before-initialize")) process.exit(1)
const exitOnRequest = flags.includes("--exit-on-request")

type Message = {
  readonly id?: number
  readonly method?: string
  readonly params?: {
    readonly textDocument?: { readonly uri?: string }
    readonly position?: { readonly line?: number; readonly character?: number }
    readonly query?: string
  }
}

type Position = { readonly line?: number; readonly character?: number }

const send = (message: unknown) => {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

const rangeAt = (position: Position | undefined) => ({
  start: position ?? { line: 0, character: 0 },
  end: position ?? { line: 0, character: 0 },
})

const handle = (message: Message): unknown => {
  const uri = message.params?.textDocument?.uri
  const position = message.params?.position
  switch (message.method) {
    case "textDocument/definition":
      return [{ uri, name: "MOCK_DEFINITION", range: rangeAt(position) }]
    case "textDocument/references":
      return [{ uri, name: "MOCK_REFERENCE", range: rangeAt(position) }]
    case "textDocument/hover":
      return { contents: `MOCK_HOVER ${position?.line ?? 0}:${position?.character ?? 0}` }
    case "textDocument/documentSymbol":
      return [{ name: "MOCK_DOCUMENT_SYMBOL", kind: 12, range: rangeAt(undefined), selectionRange: rangeAt(undefined) }]
    case "workspace/symbol":
      return [
        {
          name: `MOCK_WORKSPACE_${message.params?.query ?? ""}`,
          kind: 12,
          location: { uri, range: rangeAt(undefined) },
        },
        { name: "MOCK_WORKSPACE_IGNORED", kind: 99, location: { uri, range: rangeAt(undefined) } },
      ]
    case "textDocument/implementation":
      return [{ uri, name: "MOCK_IMPLEMENTATION", range: rangeAt(position) }]
    case "textDocument/prepareCallHierarchy":
      return [{ name: "MOCK_CALL", kind: 12, uri, range: rangeAt(position), selectionRange: rangeAt(position) }]
    case "callHierarchy/incomingCalls":
      return [
        {
          from: { name: "MOCK_CALLER", kind: 12, uri, range: rangeAt(position), selectionRange: rangeAt(position) },
          fromRanges: [rangeAt(position)],
        },
      ]
    case "callHierarchy/outgoingCalls":
      return [
        {
          to: { name: "MOCK_CALLEE", kind: 12, uri, range: rangeAt(position), selectionRange: rangeAt(position) },
          fromRanges: [rangeAt(position)],
        },
      ]
    default:
      return undefined
  }
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
    const message = JSON.parse(body) as Message
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })
    } else if (message.method === "textDocument/didOpen") {
      const uri = message.params?.textDocument?.uri
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
    } else if (message.id !== undefined) {
      if (exitOnRequest) process.exit(1)
      send({ jsonrpc: "2.0", id: message.id, result: handle(message) ?? null })
    }
  }
})
