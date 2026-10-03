import { batch } from "solid-js"
import type { Workspace } from "@miao/schema/view-models"
import type { LocationPath } from "@miao/protocol/groups/location"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies LocationPath

    const [store, setStore] = createStore({
      project: {
        id: undefined as string | undefined,
        worktree: undefined as string | undefined,
        mainDir: undefined as string | undefined,
      },
      instance: {
        path: defaultPath,
      },
      workspace: {
        current: undefined as string | undefined,
        list: [] as Workspace[],
        status: {} as Record<string, WorkspaceStatus>,
      },
    })

    async function sync() {
      const workspace = store.workspace.current
      const [instancePath, project] = await Promise.all([
        sdk.client.v2.location.get({ location: { workspace } }),
        sdk.client.v2.project.current({ location: { workspace } }),
      ])
      const current = project.data?.data
      const directories = current?.id
        ? await sdk.client.v2.project.directories({ projectID: current.id, location: { workspace } })
        : undefined
      batch(() => {
        const location = instancePath.data
        setStore(
          "instance",
          "path",
          reconcile({
            ...defaultPath,
            directory: location?.directory ?? defaultPath.directory,
            worktree: location?.project.directory ?? defaultPath.worktree,
          }),
        )
        setStore("project", "id", current?.id)
        setStore("project", "worktree", current?.directory)
        setStore(
          "project",
          "mainDir",
          directories?.data?.data?.findLast((item) => item.strategy === undefined)?.directory,
        )
      })
    }

    async function syncWorkspace() {
      const listed = await sdk.client.v2.workspace.list().catch(() => undefined)
      if (!listed?.data) return
      const status = await sdk.client.v2.workspace.status().catch(() => undefined)
      const next = Object.fromEntries((status?.data?.data ?? []).map((item) => [item.workspaceID, item.status]))
      const workspaces = (listed.data.data ?? []) as Workspace[]

      batch(() => {
        setStore("workspace", "list", reconcile(workspaces))
        setStore("workspace", "status", reconcile(next))
        if (!workspaces.some((item) => item.id === store.workspace.current)) {
          setStore("workspace", "current", undefined)
        }
      })
    }

    sdk.event.on("event", (event) => {
      if (event.payload.type === "workspace.status") {
        setStore("workspace", "status", event.payload.properties.workspaceID, event.payload.properties.status)
      }
    })

    return {
      data: store,
      project() {
        return store.project.id
      },
      instance: {
        path() {
          return store.instance.path
        },
        directory() {
          return store.instance.path.directory
        },
      },
      workspace: {
        current() {
          return store.workspace.current
        },
        set(next?: string | null) {
          const workspace = next ?? undefined
          if (store.workspace.current === workspace) return
          setStore("workspace", "current", workspace)
        },
        list() {
          return store.workspace.list
        },
        get(workspaceID: string) {
          return store.workspace.list.find((item) => item.id === workspaceID)
        },
        status(workspaceID: string) {
          return store.workspace.status[workspaceID]
        },
        statuses() {
          return store.workspace.status
        },
        sync: syncWorkspace,
      },
      sync,
    }
  },
})
