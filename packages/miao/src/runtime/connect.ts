export * as RuntimeConnect from "./connect"

import { RuntimeHost } from "./host"

/** Start a fresh runtime owned by this invocation. No discovery or detached processes. */
export async function open(filename: string) {
  return (await RuntimeHost.start(filename)).record
}
