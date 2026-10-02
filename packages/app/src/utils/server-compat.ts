import type { ServerApi } from "./server"

export type CompatibleApi = ServerApi

// The app talks only to the current (V2) session API.
export function createCompatibleApi(input: { current: ServerApi }): CompatibleApi {
  return input.current
}
