import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { MiaoAgent, type Options } from "./agent"

export { AuthMethodID, MiaoAgent, type Options } from "./agent"
export type { Client } from "./types"

/**
 * Serves ACP over a byte stream pair (stdio for `miao acp`). Resolves when the
 * client closes the connection.
 */
export function serve(
  input: Options & { readonly output: WritableStream<Uint8Array>; readonly input: ReadableStream<Uint8Array> },
) {
  const connection = new AgentSideConnection(
    (conn) => new MiaoAgent(conn, input),
    ndJsonStream(input.output, input.input),
  )
  return { connection, closed: connection.closed }
}
