import type {
  Message,
  UserMessage,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpServerStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderAuthMethod,
  IntegrationInfo,
  VcsInfo,
  SnapshotFileDiff,
} from "@miao/sdk/v2"
import type { TuiTranscriptMessage } from "@miao/plugin/tui"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import {
  isLiveSessionV2Event,
  isV2StreamFragmentEvent,
  mergeTranscript,
  sessionContextToMessages,
  type OlderHistory,
} from "./session-v2"
import { sessionInfo } from "./session-v2-read"
import { toAgent, toCommand, toProviderCatalog, toProviderList, type ProviderCatalog } from "./v2-adapters"
import { createSessionRefreshScheduler } from "./session-refresh"
import { createPendingPrompts } from "./pending-prompts"
import { promptInputFromParts } from "./session-v2-write"
import { SessionMessage } from "@miao/core/session/message"
import type { PromptInfo } from "../prompt/history"
import { errorMessage } from "../util/error"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

// The V2 status omits the display name and root the V1 shape carried; keep the
// existing store/render shape by projecting the server id.
function toLspStatus(items: ReadonlyArray<{ id: string; connected: boolean }>): LspStatus[] {
  return items.map((item) => ({
    id: item.id,
    name: item.id,
    root: "",
    status: item.connected ? "connected" : "error",
  }))
}

// The V2 MCP status is a discriminated union with the same members as the V1
// shape the TUI store keeps, but under a different schema identity; project it
// back to the shape consumers already render.
export function toMcpStatus(raw: Record<string, McpServerStatus>): Record<string, McpStatus> {
  return raw as unknown as Record<string, McpStatus>
}

// The V2 integration method carries the id, but the V1 provider-auth shape the
// TUI store keeps does not; preserve it so OAuth connect can target the method.
type TuiAuthMethod = ProviderAuthMethod & { id?: string }

// The V2 integration list replaces the V1 provider-auth map; env methods are
// discovery-only, so only oauth and key methods become connectable entries.
function toProviderAuth(integrations: ReadonlyArray<IntegrationInfo>): Record<string, TuiAuthMethod[]> {
  const result: Record<string, TuiAuthMethod[]> = {}
  for (const integration of integrations) {
    result[integration.id] = integration.methods.flatMap((method): TuiAuthMethod[] => {
      if (method.type === "env") return []
      if (method.type === "oauth")
        return [
          {
            type: "oauth" as const,
            id: method.id,
            label: method.label,
            ...(method.prompts ? { prompts: method.prompts } : {}),
          },
        ]
      return [{ type: "api" as const, label: method.label ?? "API key" }]
    })
  }
  return result
}

// Config is served as a permissive object until its V2 schema moves into
// Schema; keep the store shape the TUI already reads.
function toConfig(raw: Record<string, unknown>): Config {
  return raw as unknown as Config
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderCatalog
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, TuiAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: TuiTranscriptMessage[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const pendingPrompts = createPendingPrompts()
    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    // Older timeline pages stay out of the store until a reader asks for them, so
    // opening a long session never pays for its whole history up front.
    const olderHistory = new Map<string, OlderHistory>()
    const loadingOlder = new Set<string>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      const query = sessionListQuery()
      const promise = sdk.client.v2.session
        .list({ limit: 200, ...(query.path ? { subpath: query.path } : {}) })
        .then((x) => ({ data: (x.data?.data ?? []).map(sessionInfo) }))
      return promise.then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    // V2 renders from hydrated context. A trailing-only debounce starves the
    // transcript while deltas keep arriving, so coalesce with a fixed deadline.
    let refreshSession: ((sessionID: string) => Promise<void>) | undefined
    let refreshStatus: ((sessionID: string) => Promise<void>) | undefined
    const v2Refresh = createSessionRefreshScheduler({
      refresh: async (sessionID) => {
        await refreshSession?.(sessionID)
        await refreshStatus?.(sessionID)
      },
      onError: (error) => console.error("Failed to refresh V2 session", error),
    })
    onCleanup(() => v2Refresh.dispose())

    // Text and reasoning fragments append in place. `touchPart` keeps an
    // in-flight re-hydration from clobbering the locally streamed value; the
    // durable `ended` event later replaces it with the authoritative text.
    const appendV2StreamText = (sessionID: string, messageID: string, partID: string, delta: string) => {
      const parts = store.part[messageID]
      if (!parts?.some((part) => part.id === partID)) {
        // The message or part has not been projected yet (for example the first
        // delta beats the `*.started` re-hydration, or the session is still
        // doing its initial sync). Ask for a refresh so the accumulated value
        // appears instead of silently dropping the fragment.
        v2Refresh.schedule(sessionID)
        return
      }
      touchPart(sessionID, partID)
      setStore(
        "part",
        messageID,
        produce((draft) => {
          const target = draft.find((part) => part.id === partID)
          if (target?.type === "text" || target?.type === "reasoning") target.text += delta
        }),
      )
    }

    event.subscribe((event, { workspace }) => {
      if (isLiveSessionV2Event(event.type) && !isV2StreamFragmentEvent(event.type)) {
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sessionID) v2Refresh.schedule(sessionID)
      }
      switch (event.type) {
        case "session.next.prompt.admitted":
        case "session.next.prompted": {
          const input = event.properties
          // A promoted prompt is visible history now, so its local receipt has to
          // go either way. `send` schedules a refresh that can hydrate the message
          // before this event arrives, and returning early on that race used to
          // leave the receipt pinned to the tail of the transcript forever.
          if (event.type === "session.next.prompted") pendingPrompts.remove(input.messageID)
          if (store.message[input.sessionID]?.some((message) => message.id === input.messageID)) break
          const session = store.session.find((session) => session.id === input.sessionID)
          const [message] = sessionContextToMessages({
            sessionID: input.sessionID,
            cwd: session?.directory ?? "",
            root: session?.directory ?? "",
            messages: [
              {
                id: input.messageID,
                type: "user",
                time: { created: input.timestamp },
                text: input.prompt.text,
                files: input.prompt.files,
                agents: input.prompt.agents,
              },
            ],
          })
          if (message.info.role !== "user") break
          const info = {
            ...message.info,
            agent: pendingPrompts.data[input.messageID]?.info.agent ?? session?.agent ?? "",
            model: pendingPrompts.data[input.messageID]?.info.model ?? {
              providerID: session?.model?.providerID ?? "",
              modelID: session?.model?.id ?? "",
            },
          }
          if (event.type === "session.next.prompt.admitted") {
            pendingPrompts.add({ info, parts: message.parts, state: "admitted", delivery: input.delivery })
            pendingPrompts.admit(input.messageID)
            break
          }
          touchMessage(input.sessionID, input.messageID)
          message.parts.forEach((part) => touchPart(input.sessionID, part.id))
          batch(() => {
            setStore("message", input.sessionID, (messages = []) => [...messages, info].toSorted(compareMessage))
            setStore("part", input.messageID, message.parts)
            pendingPrompts.remove(input.messageID)
          })
          break
        }
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "permission.asked": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "question.replied":
        case "question.rejected": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "question.asked": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "permission.v2.asked": {
          const request = event.properties
          const mapped = {
            id: request.id,
            sessionID: request.sessionID,
            permission: request.action,
            patterns: request.resources,
            metadata: request.metadata ?? {},
            always: request.save ?? [],
            tool:
              request.source?.type === "tool"
                ? { messageID: request.source.messageID, callID: request.source.callID }
                : undefined,
          } as unknown as PermissionRequest
          if (permission.mode === "auto") {
            void sdk.client.v2.session.permission.reply({
              sessionID: request.sessionID,
              requestID: request.id,
              reply: "once",
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [mapped])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(mapped))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, mapped)
            }),
          )
          break
        }

        case "permission.v2.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.v2.asked": {
          const request = event.properties as unknown as QuestionRequest
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.v2.replied":
        case "question.v2.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const id = event.properties.info.id
          const result = search(store.session, id, (s) => s.id)
          const messages = store.message[id]
          batch(() => {
            if (result.found) {
              setStore(
                "session",
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
            }
            setStore(
              produce((draft) => {
                delete draft.message[id]
                delete draft.todo[id]
                delete draft.session_diff[id]
                delete draft.session_status[id]
                delete draft.permission[id]
                delete draft.question[id]
                if (messages) for (const message of messages) delete draft.part[message.id]
              }),
            )
          })
          fullSyncedSessions.delete(id)
          syncingSessions.delete(id)
          hydratingSessions.delete(id)
          pendingPrompts.clear(id)
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.text.delta": {
          appendV2StreamText(
            event.properties.sessionID,
            event.properties.assistantMessageID,
            event.properties.textID,
            event.properties.delta,
          )
          break
        }

        case "session.next.reasoning.delta": {
          appendV2StreamText(
            event.properties.sessionID,
            event.properties.assistantMessageID,
            event.properties.reasoningID,
            event.properties.delta,
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "message.updated": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }
        case "message.removed": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }
        case "message.part.updated": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "message.part.delta": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "message.part.removed": {
          // V1 runtime event; the V2 TUI reads sessions through session.next.* and the V2 API.
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.v2.lsp
            .status({ location: { workspace } })
            .then((x) => setStore("lsp", toLspStatus(x.data?.data ?? [])))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    // `provider.list` carries the whole models.dev catalog (several MB) while
    // startup only needs the connected providers from `config.providers`, so the
    // catalog loads when something like the connect dialog first asks for it.
    let providerCatalog: Promise<void> | undefined
    function loadProviderCatalog() {
      providerCatalog ??= sdk.client.v2.config
        .catalog({ location: { workspace: project.workspace.current() } }, { throwOnError: true })
        .then((x) => setStore("provider_next", reconcile(toProviderCatalog(x.data!.data))))
        .catch((error) => {
          providerCatalog = undefined
          throw error
        })
      return providerCatalog
    }

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      // A loaded catalog may be stale after a reconnect or workspace switch;
      // refresh it in the background instead of fetching one nobody asked for.
      const reloadProviderCatalog = providerCatalog !== undefined
      providerCatalog = undefined
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.v2.config.providers({ location: { workspace } }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.v2.capabilities
        .get({ location: { workspace } }, { throwOnError: true })
        .then((x) => x.data?.data)
        .catch(() => undefined)
      const agentsPromise = sdk.client.v2.agent.list({ location: { workspace } }, { throwOnError: true })
      const configPromise = sdk.client.v2.config.get({ location: { workspace } }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => toProviderList(x.data!.data))
          const capabilitiesResponse = capabilitiesPromise
          const agentsResponse = agentsPromise.then((x) => (x.data?.data ?? []).map(toAgent))
          const configResponse = configPromise.then((x) => toConfig(x.data?.data ?? {}))
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            capabilitiesResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const capabilities = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            // The palette only shows names and descriptions; executing a command
            // resolves its template on the server.
            sdk.client.v2.command
              .list({ location: { workspace } })
              .then((x) => setStore("command", reconcile((x.data?.data ?? []).map(toCommand)))),
            sdk.client.v2.lsp
              .status({ location: { workspace } })
              .then((x) => setStore("lsp", reconcile(toLspStatus(x.data?.data ?? [])))),
            sdk.client.v2.mcp
              .status({ location: { workspace } })
              .then((x) => setStore("mcp", reconcile(toMcpStatus(x.data?.data ?? {})))),
            sdk.client.v2.mcp
              .resources({ location: { workspace } }, { throwOnError: true })
              .then((x) => setStore("mcp_resource", reconcile(x.data?.data ?? {}))),
            sdk.client.v2.formatter
              .status({ location: { workspace } })
              .then((x) => setStore("formatter", reconcile(x.data?.data ?? []))),
            sdk.client.v2.session
              .active()
              .then((x) => ({
                data: Object.fromEntries(Object.keys(x.data?.data ?? {}).map((id) => [id, { type: "busy" as const }])),
              }))
              .then((x) => {
                setStore("session_status", reconcile(x.data ?? {}))
              }),
            sdk.client.v2.integration
              .list({ location: { workspace } })
              .then((x) => setStore("provider_auth", reconcile(toProviderAuth(x.data?.data ?? [])))),
            ...(reloadProviderCatalog
              ? [
                  loadProviderCatalog().catch((error) =>
                    console.error("provider catalog refresh failed", { error: errorMessage(error) }),
                  ),
                ]
              : []),
            sdk.client.v2.vcs
              .get({ location: { workspace } }, { throwOnError: true })
              .then((x) => setStore("vcs", reconcile(x.data?.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    // A V2 prompt carries only its text: the session runs with the agent and model
    // stored on it. Apply what the footer has selected before sending, or a model
    // picked after the session started never takes effect. switchModel is a no-op
    // on the server when nothing changed; switchAgent records an event, so it is
    // only sent when the agent differs.
    async function applySelection(input: { sessionID: string; agent: string; model: UserMessage["model"] }) {
      const match = search(store.session, input.sessionID, (s) => s.id)
      const session = match.found ? store.session[match.index] : undefined
      if (input.agent && session?.agent !== input.agent)
        await sdk.client.v2.session.switchAgent(
          { sessionID: input.sessionID, agent: input.agent },
          { throwOnError: true },
        )
      if (!input.model.providerID || !input.model.modelID) return
      await sdk.client.v2.session.switchModel(
        {
          sessionID: input.sessionID,
          model: { id: input.model.modelID, providerID: input.model.providerID, variant: input.model.variant },
        },
        { throwOnError: true },
      )
    }

    const result = {
      data: store,
      prompt: {
        ...pendingPrompts,
        async send(input: {
          sessionID: string
          agent: string
          model: UserMessage["model"]
          parts: PromptInfo["parts"]
        }) {
          const id = SessionMessage.ID.create()
          pendingPrompts.add({
            info: {
              id,
              sessionID: input.sessionID,
              role: "user",
              agent: input.agent,
              model: input.model,
              time: { created: Date.now() },
            },
            parts: input.parts.map((part, index) => ({
              ...part,
              id: `${id}-${index}`,
              messageID: id,
              sessionID: input.sessionID,
            })),
            state: "sending",
            delivery: "steer",
          })
          return applySelection(input)
            .then(() =>
              sdk.client.v2.session.prompt(
                { id, sessionID: input.sessionID, prompt: promptInputFromParts(input.parts) },
                { throwOnError: true },
              ),
            )
            .then(
              (response) => {
                pendingPrompts.admit(id)
                v2Refresh.schedule(input.sessionID)
                return response
              },
              (error: unknown) => {
                pendingPrompts.fail(id, errorMessage(error))
                throw error
              },
            )
        },
      },
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        async syncStatus(sessionID: string, signal?: AbortSignal) {
          const response = await sdk.client.v2.session.status({ sessionID }, { throwOnError: true, signal })
          const status = response.data.data.type
          if (signal?.aborted) return status
          const previous = store.session_status[sessionID]?.type
          // Every store write notifies subscribers, and one tick repaints the
          // whole screen (see sidebar/context.tsx), so an unchanged idle status
          // must not be written back once a second.
          if (previous !== status) setStore("session_status", sessionID, { type: status })
          // An idle transition is also a recovery path for a missed terminal
          // event: fetch the final transcript instead of leaving stale output.
          if (previous === "busy" && status === "idle") v2Refresh.schedule(sessionID)
          return status
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          if (store.session_status[sessionID])
            return store.session_status[sessionID].type === "idle" ? "idle" : "working"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const sessionPromise = sdk.client.v2.session
              .get({ sessionID }, { throwOnError: true })
              .then((x) => ({ data: sessionInfo(x.data.data) }))
            const messagesPromise = sessionPromise.then((session) =>
              Promise.all([
                sdk.client.v2.session.context({ sessionID }, { throwOnError: true }),
                // `context` stops at the last compaction, so also read a page
                // of the projected timeline to keep older history reachable.
                sdk.client.v2.session.messages({ sessionID, limit: 200, order: "desc" }, { throwOnError: true }),
              ]).then(([context, history]) => {
                // Seed the older-history walk once. Later re-hydrations must
                // not reset it to the newest page, or every scroll to the
                // top would refetch a page that is already loaded.
                const seeded = olderHistory.get(sessionID)
                const older = seeded ?? { messages: [], cursor: history.data.cursor.next }
                if (!seeded) olderHistory.set(sessionID, older)
                return {
                  data: sessionContextToMessages({
                    sessionID,
                    cwd: session.data!.directory,
                    root: session.data!.directory,
                    messages: mergeTranscript(context.data.data, [...older.messages, ...history.data.data]),
                  }),
                }
              }),
            )
            const [session, messages, todo, diff] = await Promise.all([
              sessionPromise,
              messagesPromise,
              sdk.client.v2.session.todo({ sessionID }).then((x) => ({ data: x.data?.data })),
              sdk.client.v2.session.diff({ sessionID }).then((x) => ({
                data: (x.data?.data ?? []).map((file) => ({
                  file: file.path,
                  patch: file.patch,
                  additions: file.additions,
                  deletions: file.deletions,
                  status: file.status,
                })),
              })),
            ])
            batch(() => {
              const match = search(store.session, sessionID, (s) => s.id)
              if (match.found) setStore("session", match.index, reconcile(session.data!))
              if (!match.found) setStore("session", (sessions) => sessions.toSpliced(match.index, 0, session.data!))
              setStore("todo", sessionID, reconcile(todo.data ?? []))
              const currentMessages = store.message[sessionID] ?? []
              const currentByID = new Map(currentMessages.map((message) => [message.id, message]))
              const infos = (messages.data ?? []).flatMap((message) => {
                if (!tracker.messages.has(message.info.id)) return [message.info]
                const current = currentByID.get(message.info.id)
                return current ? [current] : []
              })
              const hydratedIDs = new Set(infos.map((message) => message.id))
              infos.push(
                ...currentMessages.filter(
                  (message) => tracker.messages.has(message.id) && !hydratedIDs.has(message.id),
                ),
              )
              infos.sort(compareMessage)
              // Render the whole active context (everything since the last
              // compaction). Windowing this to the newest N messages made the
              // transcript feel scroll-locked because older history existed
              // server-side but was never rendered.
              const visibleIDs = new Set(infos.map((message) => message.id))
              const removed = currentMessages.filter((message) => !visibleIDs.has(message.id))
              for (const message of messages.data ?? []) {
                if (!visibleIDs.has(message.info.id)) {
                  setStore("part", message.info.id, undefined!)
                  continue
                }
                const currentParts = store.part[message.info.id] ?? []
                const currentByID = new Map(currentParts.map((part) => [part.id, part]))
                const parts = message.parts.flatMap((part) => {
                  const current = currentByID.get(part.id)
                  if (tracker.parts.has(part.id)) return current ? [current] : []
                  if (
                    current &&
                    (part.type === "text" || part.type === "reasoning") &&
                    (current.type === "text" || current.type === "reasoning") &&
                    part.text.length === 0 &&
                    current.text.length > 0
                  ) {
                    return [current]
                  }
                  return [part]
                })
                const hydratedIDs = new Set(parts.map((part) => part.id))
                parts.push(...currentParts.filter((part) => tracker.parts.has(part.id) && !hydratedIDs.has(part.id)))
                setStore("part", message.info.id, reconcile(parts))
              }
              for (const message of removed) setStore("part", message.id, undefined!)
              // Preserve keyed store proxies so <For> keeps existing UI nodes.
              // Replacing every object remounts the entire transcript on
              // each hydration, including completed text and tool output.
              setStore("message", sessionID, reconcile(infos))
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            })
            pendingPrompts.reconcile(
              sessionID,
              (messages.data ?? []).map((message) => message.info),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
        /**
         * Pull the timeline page behind everything already held and re-hydrate.
         * Called only when a reader reaches the top of the transcript; returns
         * false once the session's oldest page has been reached.
         */
        async loadOlder(sessionID: string) {
          const older = olderHistory.get(sessionID)
          if (!older?.cursor || loadingOlder.has(sessionID)) return false
          loadingOlder.add(sessionID)
          try {
            const page = await sdk.client.v2.session.messages(
              { sessionID, limit: 200, cursor: older.cursor },
              { throwOnError: true },
            )
            if (page.data.data.length === 0) {
              olderHistory.set(sessionID, { ...older, cursor: undefined })
              return false
            }
            olderHistory.set(sessionID, {
              messages: [...page.data.data, ...older.messages],
              cursor: page.data.cursor.next,
            })
            fullSyncedSessions.delete(sessionID)
            await result.session.sync(sessionID)
            return true
          } finally {
            loadingOlder.delete(sessionID)
          }
        },
      },
      bootstrap,
      loadProviderCatalog,
      dismissQuestion(sessionID: string, requestID: string) {
        const requests = store.question[sessionID]
        if (!requests) return
        const match = search(requests, requestID, (request) => request.id)
        if (!match.found) return
        setStore(
          "question",
          sessionID,
          produce((draft) => {
            draft.splice(match.index, 1)
          }),
        )
      },
      dismissPermission(sessionID: string, requestID: string) {
        const requests = store.permission[sessionID]
        if (!requests) return
        const match = search(requests, requestID, (request) => request.id)
        if (!match.found) return
        setStore(
          "permission",
          sessionID,
          produce((draft) => {
            draft.splice(match.index, 1)
          }),
        )
      },
    }
    refreshSession = async (sessionID) => {
      // Initial hydration may predate the event that requested this refresh.
      // Join it first, then read a fresh snapshot instead of dropping the event.
      await syncingSessions.get(sessionID)
      fullSyncedSessions.delete(sessionID)
      await result.session.sync(sessionID)
    }
    // Execution can be busy before any provider frame arrives, or idle after
    // an interrupted user prompt. The transcript is not an ownership signal.
    refreshStatus = async (sessionID) => {
      await result.session.syncStatus(sessionID)
    }
    return result
  },
})
