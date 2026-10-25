import { nativeModelLabel } from "../util/native-model"
import { createMemo, createResource, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

/** A native Session selects only routes published by its owning engine. */
export function DialogNativeModel(props: { sessionID: string; providerID?: string }) {
  const sdk = useSDK()
  const local = useLocal()
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
  const [integrations] = createResource(() =>
    sdk.api.integrations
      .list({ location: { directory: sdk.directory } })
      .then((result) => result.data)
      .catch((error: unknown) => {
        toast.error(error)
        return []
      }),
  )
  const options = createMemo(() =>
    (routes() ?? []).flatMap((route) => {
      const label = nativeModelLabel(route, sync.data.provider)
      if (props.providerID && label.providerID !== props.providerID) return []
      return [undefined, ...(route.variants ?? [])].map((variant) => ({
        title: `${label.model}${route.default ? " (default)" : ""}${variant === undefined ? "" : ` · ${variant}`}`,
        description: [
          integrations()
            ?.flatMap((integration) =>
              integration.connections.flatMap((connection) =>
                connection.type === "credential" && connection.id === route.credentialID ? [connection.label] : [],
              ),
            )
            .at(0),
          route.protocol,
          route.wireModel,
        ]
          .filter(Boolean)
          .join(" · "),
        category: label.provider,
        value: { ...route.model, ...(variant === undefined ? {} : { variant }) },
        footer:
          sync.session.get(props.sessionID)?.model?.providerID === route.model.providerID &&
          sync.session.get(props.sessionID)?.model?.id === route.model.id &&
          sync.session.get(props.sessionID)?.model?.variant === variant
            ? "Selected"
            : undefined,
      }))
    }),
  )
  return (
    <DialogSelect
      title="Select model"
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
            const selected = routes()?.find(
              (route) => route.model.providerID === option.value.providerID && route.model.id === option.value.id,
            )
            if (selected?.productModel)
              local.model.rememberNative(props.sessionID, { ...selected.productModel, variant: option.value.variant })
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
