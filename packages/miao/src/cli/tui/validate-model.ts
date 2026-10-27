import { createClient } from "@/client"

// An explicit `--model` this channel cannot serve has to fail before the TUI
// starts. The picker otherwise falls back to another model, and the only trace
// is a warning toast that scrolls away. `/api/model` already answers the same
// question the TUI asks of its provider store, so this mirrors `miao run`'s
// preflight instead of inventing a second notion of "valid".
export async function validateModel(input: {
  url: string
  model?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.model) return
  const [providerID, ...rest] = input.model.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`Invalid model format: ${input.model}`)

  const models = await createClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  })
    .models.list({ location: { directory: input.directory } })
    .then(
      (result) => result.data,
      () => undefined,
    )
  // An unreadable catalog is not proof the model is missing; let the TUI report
  // whatever it can rather than refusing to start on a flaky read.
  if (!models) return
  if (models.some((model) => model.providerID === providerID && model.id === modelID)) return
  throw new Error(`Model not found: ${providerID}/${modelID}`)
}
