import path from "node:path"
import { ClientSideConnection, ndJsonStream, type Client } from "@agentclientprotocol/sdk"

const binary = process.env.MIAO_ENGINE_BIN

/** The published executable and the independent ACP SDK meet at stdio, not at
 * engine-internal helpers or a hand-written copy of its JSON-RPC protocol. */
export async function connectNativeACP(
  directory: string,
  endpoint: string,
  client: Client,
  options: { workspace?: string; args?: string[] } = {},
) {
  if (!binary) throw new Error("MIAO_ENGINE_BIN is required")
  const child = Bun.spawn(
    [
      binary,
      "acp",
      "--db",
      path.join(directory, "engine.db"),
      "--workspace",
      options.workspace ?? directory,
      "--provider",
      "openai-chat",
      "--model",
      "fixture",
      "--endpoint",
      endpoint,
      "--policy",
      path.join(directory, "policy.json"),
      ...(options.args ?? []),
    ],
    { env: { ...process.env, OPENAI_API_KEY: "fixture-only" }, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  )
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          child.stdin.write(chunk)
          await child.stdin.flush()
        },
        close() {
          child.stdin.end()
        },
      }),
      child.stdout,
    ),
  )
  try {
    await connection.initialize({ protocolVersion: 1, clientCapabilities: {} })
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  }
  return {
    connection,
    async [Symbol.asyncDispose]() {
      child.stdin.end()
      const timeout = setTimeout(() => child.kill(), 3000)
      try {
        await child.exited
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
