import { appendFile } from "node:fs/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "a.b",
      description: "Dot form",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "a_b",
      description: "Underscore form",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Lets tests prove a denied call never reached the server.
  const log = process.env.MOCK_MCP_CALL_LOG
  if (log) await appendFile(log, request.params.name + "\n")
  return {
    content: [{ type: "text", text: `echo:${String((request.params.arguments as { text?: string })?.text ?? "")}` }],
  }
})

await server.connect(new StdioServerTransport())
