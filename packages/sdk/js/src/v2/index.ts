export * from "./client.js"
export * from "./server.js"

import { createMiaoClient } from "./client.js"
import { createMiaoServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createMiao(options?: ServerOptions) {
  const server = await createMiaoServer({
    ...options,
  })

  const client = createMiaoClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
