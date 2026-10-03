import type { PluginInput } from "@opencode-ai/plugin"
import type { Auth } from "@/auth"

// Built-in plugins persist rotated credentials straight to the auth store; the server
// route they once reached through `client.auth.set` is gone. Writes are best-effort and
// never reject, as the HTTP call never did.
export type InternalPluginInput = PluginInput & {
  auth: { set: (providerID: string, info: Auth.Info) => Promise<void> }
}
