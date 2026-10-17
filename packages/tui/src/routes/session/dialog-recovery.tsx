import { createMemo, createResource, createSignal } from "solid-js"
import type { SessionRecovery } from "@miao/schema/session-recovery"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

type Choice =
  | { type: "call"; call: SessionRecovery.Call }
  | { type: "next"; after: string }
  | { type: "first" }
  | { type: "refresh" }

export function DialogRecovery(props: { sessionID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const theme = useTheme().theme
  const [after, setAfter] = createSignal<string>()
  const [failure, setFailure] = createSignal<string>()
  const [page, { refetch }] = createResource(
    () => ({ after: after() }),
    (query) => {
      setFailure(undefined)
      return sdk.api.sessions.recoveries({ sessionID: props.sessionID, after: query.after }).then(
        (result) => result,
        (error: unknown) => {
          setFailure(errorMessage(error))
          return undefined
        },
      )
    },
  )
  const pending = createMemo(
    () => page()?.calls.flatMap((call) => (call.resolution === null ? [{ ...call, resolution: null }] : [])) ?? [],
  )
  const options = createMemo<DialogSelectOption<Choice>[]>(() => {
    const next = page()?.hasMore ? page()?.calls.at(-1) : undefined
    return [
      ...pending().map(
        (call): DialogSelectOption<Choice> => ({
          title: call.tool,
          description: `${call.callID} · outcome unknown`,
          value: { type: "call", call },
          category: "Interrupted tools",
        }),
      ),
      ...(next
        ? [
            {
              title: "Next page",
              value: { type: "next", after: next.callID },
              category: "Navigation",
            } satisfies DialogSelectOption<Choice>,
          ]
        : []),
      ...(after()
        ? [
            {
              title: "First page",
              value: { type: "first" },
              category: "Navigation",
            } satisfies DialogSelectOption<Choice>,
          ]
        : []),
      { title: "Refresh", value: { type: "refresh" }, category: "Navigation" },
    ]
  })
  return (
    <DialogSelect
      title="Recover interrupted tools"
      options={options()}
      locked={page.loading}
      detail={
        <text fg={theme.textMuted}>
          {page.loading
            ? "Loading unknown outcomes…"
            : (failure() ??
              (pending().length === 0
                ? "No unresolved tool outcomes on this page."
                : "Choose a tool to retry or abandon. Its previous outcome remains unknown."))}
        </text>
      }
      onSelect={(option) => {
        const selected = option.value
        if (selected.type === "refresh") {
          void refetch()
          return
        }
        if (selected.type === "next") {
          setAfter(selected.after)
          return
        }
        if (selected.type === "first") {
          setAfter(undefined)
          return
        }
        dialog.replace(() => <RecoveryDecision sessionID={props.sessionID} call={selected.call} />)
      }}
    />
  )
}

function RecoveryDecision(props: { sessionID: string; call: SessionRecovery.Call }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().theme
  const [busy, setBusy] = createSignal(false)
  // Keep identities stable when a transport error leaves the result uncertain
  // and the user repeats the same choice in this dialog.
  const operations = { retry: crypto.randomUUID(), abandon: crypto.randomUUID() }
  const submit = (decision: SessionRecovery.Decision) => {
    if (busy()) return
    setBusy(true)
    void sdk.api.sessions
      .resolveRecovery({
        sessionID: props.sessionID,
        callID: props.call.callID,
        operationID: operations[decision],
        decision,
        resume: true,
      })
      .then(
        () => {
          dialog.clear()
          toast.show({ variant: "success", message: "Recovery decision saved; continuation scheduled", duration: 4000 })
        },
        (error: unknown) => {
          setBusy(false)
          toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
        },
      )
  }
  return (
    <DialogSelect<SessionRecovery.Decision>
      title={`Recover ${props.call.tool}`}
      locked={busy()}
      detail={
        <text fg={theme.textMuted}>
          The previous outcome remains unknown. Retry inspects current state before a new call; abandon continues
          without retrying this operation.
        </text>
      }
      options={[
        {
          title: "Inspect and retry",
          value: "retry",
          description: "Use a fresh call under current permissions if still needed",
        },
        {
          title: "Abandon this operation",
          value: "abandon",
          description: "Continue the remaining task without retrying this call",
        },
      ]}
      onSelect={(option) => submit(option.value)}
    />
  )
}
