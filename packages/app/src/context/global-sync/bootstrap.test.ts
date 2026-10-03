import { describe, expect, test } from "bun:test"
import type { AgentApi, CatalogApi, CommandApi, ReferenceApi } from "@/utils/server"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@miao/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"

type ProjectApi = ServerApi["projects"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const api = {
  agents: { list: async () => ({ location: {}, data: [] }) },
  providers: { list: async () => ({ location: {}, data: [] }) },
  models: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permissions: { listRequests: async () => ({ location: {}, data: [] }) },
  projects: {
    list: async () => ({ location: {}, data: [] }),
    current: async () => ({ location: {}, data: { id: "project", directory: "/project" } }),
  },
  questions: { listRequests: async () => ({ location: {}, data: [] }) },
  references: { list: async () => ({ location: {}, data: [] }) },
  vcs: { get: async () => ({ location: {}, data: {} }) },
  location: {
    path: async () => ({ home: "/home", state: "", config: "", worktree: "/project", directory: "/project" }),
  },
} as unknown as ServerApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("skips legacy config while refreshing a v2 directory", async () => {
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        config: {
          get: async () => {
            throw new Error("legacy directory config should not be called")
          },
        },
      } as unknown as OpencodeClient,
      api: {
        ...api,
        vcs: { get: async () => ({ location: {}, data: { branch: "feature", default_branch: "dev" } }) },
      } as unknown as ServerApi,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    // Branch review mode needs the branch and its default branch.
    expect(store.vcs).toEqual({ branch: "feature", default_branch: "dev" })
  })
})

describe("config queries", () => {
  test("projects the V2 global config onto the fields the store reads", async () => {
    const api = {
      get: async () => ({
        location: {},
        data: {
          shell: "/bin/zsh",
          model: "openai/gpt-5",
          providers: { openai: { disabled: true }, custom: { name: "Custom" } },
          plugins: ["plain", { package: "with-options", options: { level: 1 } }],
        },
      }),
    } as unknown as Parameters<typeof loadGlobalConfigQuery>[1]

    const result = await new QueryClient().fetchQuery(loadGlobalConfigQuery(ServerScope.local, api))

    expect(result).toMatchObject({
      shell: "/bin/zsh",
      model: "openai/gpt-5",
      disabled_providers: ["openai"],
      provider: { custom: { name: "Custom" } },
      plugin: ["plain", ["with-options", { level: 1 }]],
    })
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as CatalogApi
    const remote = "https://debian.example" as typeof ServerScope.local

    const location = {} as Parameters<typeof loadPathQuery>[2]
    expect([...loadPathQuery(ServerScope.local, "/repo", location).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", location).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    const api = {
      providers: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return {
            location: {},
            data: [
              {
                id: "openai",
                name: "OpenAI",
                api: { type: "aisdk", package: "@ai-sdk/openai" },
                request: { headers: {}, body: {} },
              },
            ],
          }
        },
      },
      models: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
        default: async (input: unknown) => {
          calls.push(["default", input])
          return { location: {}, data: null }
        },
      },
    } as unknown as CatalogApi

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
      ["default", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [] }
      },
    } as unknown as AgentApi

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([])
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const api = {
      list: async () => ({
        location: {},
        data: [
          { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
          { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
        ],
      }),
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
