import type { Agent } from "@miao/schema/agent"
import type { Model } from "@miao/schema/model"
import { SessionModelRoute } from "@miao/schema/session-model-route"
import { EngineError } from "./client"

export type Route = {
  route_id: string | null
  protocol: string
  model: string
  variants?: readonly string[]
}

export function modelRoute(model: Model.Ref, catalog: readonly Route[]) {
  // An explicit engine route (provider/endpoint/model) exposes one engine-owned
  // primary entry with no route id. Binding it by identity is required: without
  // this fallback every server-owned native Session fails admission with
  // "unknown_model_route", while the same configuration works on the CLI path.
  const primary = () =>
    catalog.find(
      (entry) =>
        entry.route_id === null && (entry.model === `${model.providerID}/${model.id}` || entry.model === model.id),
    )
  const route =
    catalog.find((entry) => {
      if (model.providerID !== SessionModelRoute.ProviderID && model.providerID !== SessionModelRoute.DefaultProviderID)
        return entry.route_id === `${model.providerID}/${model.id}`
      if (entry.route_id === null) return false
      const reference = SessionModelRoute.reference(entry.route_id)
      return reference.providerID === model.providerID && reference.id === model.id
    }) ?? primary()
  if (!route) throw new EngineError("unknown_model_route", "Model is not in the native host route catalog")
  if (model.variant !== undefined && !route.variants?.includes(model.variant))
    throw new EngineError("unknown_model_variant", "Variant is not in the native host route catalog")
  return {
    route_id: route.route_id,
    protocol: route.protocol,
    model: route.model,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  }
}

// Binding is host-resolved data. The engine keeps ordered rules intact and does
// not need to know the product's tool vocabulary or import its configuration.
const bindings = {
  task: { action: "task" },
  read_file: { action: "read" },
  read_image: { action: "read" },
  list_files: { action: "read" },
  write_file: { action: "edit" },
  edit_file: { action: "edit" },
  apply_patch: { action: "edit" },
  load_skill: { action: "skill", resource: { input: "name" } },
  glob: { action: "glob", resource: { input: "pattern" } },
  grep: { action: "grep", resource: { input: "pattern" } },
  webfetch: { action: "webfetch", resource: { input: "url" } },
  websearch: { action: "websearch", resource: { input: "query" } },
  lsp_diagnostics: { action: "lsp", resource: { literal: "*" } },
  lsp_definition: { action: "lsp", resource: { literal: "*" } },
  lsp_references: { action: "lsp", resource: { literal: "*" } },
  lsp_hover: { action: "lsp", resource: { literal: "*" } },
  lsp_implementation: { action: "lsp", resource: { literal: "*" } },
  lsp_document_symbols: { action: "lsp", resource: { literal: "*" } },
  lsp_workspace_symbols: { action: "lsp", resource: { literal: "*" } },
  lsp_call_hierarchy: { action: "lsp", resource: { literal: "*" } },
  lsp_incoming_calls: { action: "lsp", resource: { literal: "*" } },
  lsp_outgoing_calls: { action: "lsp", resource: { literal: "*" } },
  bash: { action: "bash", resource: "command" },
  run_command: { action: "bash", resource: "command" },
  start_job: { action: "bash", resource: "command" },
  monitor: { action: "bash", resource: "command" },
  terminal_start: { action: "bash", resource: "program", explicit: true },
} as const

export function agentManifest(agent: Agent.Info, catalog: readonly Route[]) {
  if (agent.permission_mode === "auto")
    throw new EngineError(
      "unsupported_agent_permission_mode",
      "Native agents require explicit permission rules; automatic host classification is not available",
    )
  return {
    name: agent.id,
    semantics: "product-agent-ordered-v1",
    ...(agent.system === undefined ? {} : { instructions: agent.system }),
    ordered_permissions: {
      semantics: "ordered-wildcard-v1",
      rules: agent.permissions,
      bindings,
    },
    ...(agent.model === undefined ? {} : { model: modelRoute(agent.model, catalog) }),
    ...(agent.steps === undefined ? {} : { steps: agent.steps }),
    ...(Object.keys(agent.request.body).length || Object.keys(agent.request.headers).length
      ? { request: agent.request }
      : {}),
  }
}
