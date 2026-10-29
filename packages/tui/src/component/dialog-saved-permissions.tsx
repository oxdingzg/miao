import type { LocationGetOutput, PermissionsListSavedOutput } from "@miao/client"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type SavedPermission = PermissionsListSavedOutput[number]
export type SavedPermissionsApi = {
  list: (signal: AbortSignal) => Promise<PermissionsListSavedOutput>
  location: (signal: AbortSignal) => Promise<LocationGetOutput>
  remove: (id: string, signal: AbortSignal) => Promise<void>
}

export function DialogSavedPermissions() {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
  const session = sync.data.session.find((item) => item.id === sessionID)
  // Freeze the displayed Location so a background workspace change cannot
  // redirect a later revoke to another owner.
  const directory = session?.location.directory ?? project.instance.directory() ?? sdk.directory
  const workspace = session ? session.location.workspaceID : project.workspace.current()
  const headers = {
    ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
    "x-opencode-workspace": workspace ?? "",
  }
  return (
    <DialogSavedPermissionsView
      api={{
        list: (signal) => sdk.api.permissions.listSaved(undefined, { headers, signal }),
        location: (signal) => sdk.api.location.get(undefined, { headers, signal }),
        remove: (id, signal) => sdk.api.permissions.removeSaved({ id }, { headers, signal }),
      }}
    />
  )
}

export function DialogSavedPermissionsView(props: { api: SavedPermissionsApi }) {
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const abort = new AbortController()
  const [state, setState] = createStore({
    rules: [] as SavedPermission[],
    location: undefined as LocationGetOutput | undefined,
    loading: false,
    revoking: false,
    error: undefined as string | undefined,
  })
  const [selectedID, setSelectedID] = createSignal<string>()
  const selected = createMemo(() => state.rules.find((rule) => rule.id === selectedID()))
  onCleanup(() => abort.abort())
  onMount(() => {
    dialog.setSize("large")
    void load()
  })

  async function load() {
    if (state.loading) return
    setState({ loading: true, error: undefined })
    const result = await Promise.all([props.api.list(abort.signal), props.api.location(abort.signal)]).then(
      ([rules, location]) => ({ rules, location }),
      (error: unknown) => ({ error: errorMessage(error) }),
    )
    if (abort.signal.aborted) return
    if ("error" in result) {
      setState({ loading: false, error: result.error })
      return
    }
    setState({ rules: [...result.rules], location: result.location, loading: false })
  }

  async function revoke(rule: SavedPermission) {
    if (state.revoking) return
    setState({ revoking: true, error: undefined })
    const result = await props.api.remove(rule.id, abort.signal).then(
      () => ({ removed: true as const }),
      (error: unknown) => ({ error: errorMessage(error) }),
    )
    if (abort.signal.aborted) return
    if ("error" in result) {
      setState({ revoking: false, error: result.error })
      return
    }
    // Only remove a row after the server acknowledges the revocation.
    setSelectedID(undefined)
    setState({ rules: state.rules.filter((item) => item.id !== rule.id), revoking: false })
    toast.show({ message: "Saved permission revoked", variant: "success" })
    await load()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "ctrl+r",
        desc: "Refresh saved permissions",
        group: "Dialog",
        cmd: () => {
          if (state.loading || state.revoking) return
          setSelectedID(undefined)
          void load()
        },
      },
    ],
  }))
  const note = () => (
    <Show when={state.error}>
      <text fg={theme.theme.error} wrapMode="word">
        {state.error}
      </text>
    </Show>
  )
  // A stable renderable root keeps the dialog factory alive while its page changes.
  return (
    <box width="100%">
      <Show
        when={selected()}
        fallback={
          <DialogSelect
            title="Saved permissions"
            placeholder="Search actions or target patterns"
            locked={state.loading || state.revoking}
            options={state.rules.map((rule) => ({
              title: `${rule.action} ${JSON.stringify(rule.resource)}`,
              value: rule,
              category: scope(rule, state.location).title,
              details: [scope(rule, state.location).description],
            }))}
            emptyView={
              <text fg={theme.theme.textMuted}>
                {state.loading
                  ? "Loading saved permissions…"
                  : state.error
                    ? "Saved permissions could not be loaded."
                    : "No saved permissions for this location."}
              </text>
            }
            detail={note()}
            footerHints={[
              { label: "enter", title: "Review" },
              { label: "ctrl+r", title: "Refresh" },
            ]}
            onSelect={(option) => {
              setState("error", undefined)
              setSelectedID(option.value.id)
            }}
          />
        }
      >
        {(selected) => (
          <DialogSelect
            title="Review saved permission"
            renderFilter={false}
            skipFilter
            current="keep"
            locked={state.revoking}
            options={[
              { title: "Keep this rule", value: "keep", description: "Return to saved permissions" },
              {
                title: state.revoking ? "Revoking…" : "Revoke this rule",
                value: "revoke",
                description: "Remove this saved authorization",
                disabled: !scope(selected(), state.location).known,
              },
            ]}
            detail={
              <box gap={1}>
                <scrollbox height={Math.max(1, Math.min(9, Math.floor(dimensions().height * 0.75) - 12))}>
                  <box gap={1}>
                    <text fg={theme.theme.text} wrapMode="word">
                      Action: {selected().action}
                    </text>
                    <text fg={theme.theme.textMuted} wrapMode="word">
                      {scope(selected(), state.location).title}: {scope(selected(), state.location).description}
                    </text>
                    <text fg={theme.theme.text} wrapMode="word">
                      Target pattern: {JSON.stringify(selected().resource)}
                    </text>
                  </box>
                </scrollbox>
                {note()}
              </box>
            }
            footer={
              <text fg={theme.theme.textMuted}>
                {state.revoking ? "Waiting for the server…" : "Configured permission rules still apply."}
              </text>
            }
            onSelect={(option) => {
              if (option.value === "keep") {
                setSelectedID(undefined)
                setState("error", undefined)
                return
              }
              if (!scope(selected(), state.location).known) return
              void revoke(selected())
            }}
          />
        )}
      </Show>
    </box>
  )
}

function scope(rule: SavedPermission, location?: LocationGetOutput) {
  if (rule.origin === "native")
    return rule.scope?.type === "directory"
      ? { title: "Directory", description: rule.scope.directory, known: true }
      : { title: "Directory", description: "Scope unavailable. Refresh the list.", known: false }
  if (rule.projectID === "global") return { title: "Shared", description: "All non-Git directories", known: true }
  return location?.project.id === rule.projectID
    ? { title: "Project", description: `${location.project.directory} (including its worktrees)`, known: true }
    : { title: "Project", description: "Scope unavailable. Refresh the list.", known: false }
}
