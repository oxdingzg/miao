import { createMemo, createResource, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

/** A native Session selects only routes published by its owning engine. */
export function DialogNativeModel(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().theme
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [routes] = createResource(
    () => props.sessionID,
    (sessionID) =>
      sdk.api.sessions.modelRoutes({ sessionID }).catch((error: unknown) => {
        setFailure(errorMessage(error))
        return []
      }),
  )
  const options = createMemo(() =>
    (routes() ?? []).flatMap((route) =>
      [undefined, ...(route.variants ?? [])].map((variant) => ({
        title: `${route.default ? `${route.wireModel} (default)` : route.model.id}${variant === undefined ? "" : ` · ${variant}`}`,
        description: `${route.protocol} · ${route.wireModel}`,
        category: "Host model routes",
        value: { ...route.model, ...(variant === undefined ? {} : { variant }) },
        footer:
          sync.session.get(props.sessionID)?.model?.providerID === route.model.providerID &&
          sync.session.get(props.sessionID)?.model?.id === route.model.id &&
          sync.session.get(props.sessionID)?.model?.variant === variant
            ? "Selected"
            : undefined,
      })),
    ),
  )
  return (
    <DialogSelect
      title="Select native model route"
      options={options()}
      locked={routes.loading || busy()}
      detail={
        <text fg={theme.textMuted}>
          {failure() ?? "Applies at the next provider turn. Endpoint and credentials are bound by the host."}
        </text>
      }
      onSelect={(option) => {
        if (busy()) return
        setBusy(true)
        void sdk.api.sessions
          .switchModel({ sessionID: props.sessionID, model: option.value })
          .then(async () => {
            await sync.session.reload(props.sessionID)
            dialog.clear()
          })
          .catch((error: unknown) => {
            setBusy(false)
            toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
          })
      }}
    />
  )
}
