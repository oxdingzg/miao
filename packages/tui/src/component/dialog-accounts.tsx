import { createMemo, createSignal, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { connectProvider } from "./dialog-provider"

type Account = { type: "credential"; id: string; label: string; active: boolean }

/** Pick a provider that has accounts, then manage them. */
export function DialogAccountProviders() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [providers, setProviders] = createSignal<{ id: string; name: string; accounts: number }[]>([])

  onMount(async () => {
    const result = await sdk.api.integrations
      .list({ location: { directory: sdk.directory } })
      .catch((error: unknown) => {
        toast.error(error)
        return undefined
      })
    if (!result) return
    setProviders(
      result.data.flatMap((integration) => {
        const accounts = integration.connections.filter((connection) => connection.type === "credential").length
        return accounts > 0 ? [{ id: integration.id, name: integration.name ?? integration.id, accounts }] : []
      }),
    )
  })

  return (
    <DialogSelect
      title="Provider accounts"
      options={providers().map((provider) => ({
        title: provider.name,
        value: provider.id,
        description: provider.accounts === 1 ? "1 account" : `${provider.accounts} accounts`,
        onSelect: () => dialog.replace(() => <DialogAccounts providerID={provider.id} />),
      }))}
    />
  )
}

/**
 * Accounts of one provider. Each stored credential is one account; the active
 * one is the account every session of that provider runs on until it is
 * switched.
 */
export function DialogAccounts(props: { providerID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const route = useRoute()
  const { theme } = useTheme()
  const [accounts, setAccounts] = createSignal<Account[]>([])

  const location = () => ({ directory: sdk.directory })
  const account = (id: string) => accounts().find((item) => item.id === id)

  async function load() {
    const result = await sdk.api.integrations.get({ integrationID: props.providerID, location: location() }).catch(
      (error: unknown) => {
        toast.error(error)
        return undefined
      },
    )
    if (!result?.data) return
    setAccounts(
      result.data.connections.filter((connection): connection is Account => connection.type === "credential"),
    )
  }
  onMount(() => void load())

  const reopen = () => dialog.replace(() => <DialogAccounts providerID={props.providerID} />)
  const session = createMemo(() => {
    const id = route.data.type === "session" ? route.data.sessionID : undefined
    return id ? sync.data.session.find((item) => item.id === id) : undefined
  })
  const describe = (item: Account) =>
    [item.active ? "active" : "inactive", session()?.credentialID === item.id ? "used in this session" : undefined]
      .filter((part) => part !== undefined)
      .join(" · ")

  async function activate(id: string): Promise<void> {
    if (account(id)?.active) return
    await sdk.api.credentials.activate({ credentialID: id, location: location() }).catch((error: unknown) => {
      toast.error(error)
      return undefined
    })
    await sync.bootstrap()
    await load()
  }

  async function rename(id: string): Promise<void> {
    const current = account(id)
    if (!current) return
    const label = await DialogPrompt.show(dialog, "Rename account", { value: current.label })
    if (label === null) return reopen()
    if (label.trim().length === 0) return reopen()
    await sdk.api.credentials
      .update({ credentialID: id, label: label.trim(), location: location() })
      .catch((error: unknown) => toast.error(error))
    await sync.bootstrap()
    reopen()
  }

  /** Pins the account to the open conversation; the provider default stays put. */
  async function pin(id: string): Promise<void> {
    const current = session()
    if (!current) return reopen()
    await sdk.api.sessions.switchAccount({ sessionID: current.id, credentialID: id }, {}).catch((error: unknown) => {
      toast.error(error)
      return undefined
    })
    await sync.bootstrap()
    reopen()
  }

  async function remove(id: string): Promise<void> {
    await sdk.api.credentials.remove({ credentialID: id, location: location() }).catch((error: unknown) => {
      toast.error(error)
      return undefined
    })
    await sync.bootstrap()
    reopen()
  }

  async function confirmRemove(id: string): Promise<void> {
    const current = account(id)
    if (!current) return
    const confirmed = await DialogConfirm.show(
      dialog,
      "Remove account",
      `${current.label} will no longer be available for this provider.`,
      "Remove",
    )
    if (confirmed !== true) return reopen()
    await remove(id)
  }

  async function add(): Promise<void> {
    const suggestion = `account-${accounts().length + 1}`
    const label = await DialogPrompt.show(dialog, "New account", {
      placeholder: suggestion,
      description: () => (
        <text fg={theme.textMuted}>
          Names this account. A label already in use replaces that account instead of adding one.
        </text>
      ),
    })
    if (label === null) return reopen()
    await connectProvider({
      providerID: props.providerID,
      label: label.trim() || suggestion,
      dialog,
      sdk,
      sync,
      toast,
      onConnected: reopen,
    })
  }

  const options = createMemo(() => [
    ...accounts().map((item) => ({
      title: item.label,
      value: item.id,
      description: describe(item),
      gutter: item.active ? () => <text fg={theme.success}>✓</text> : undefined,
      onSelect: (): void => void activate(item.id),
    })),
    {
      title: "Add account",
      value: "add",
      description: "Sign in to another account of this provider",
      onSelect: (): void => void add(),
    },
  ])

  return (
    <DialogSelect
      title={`Accounts · ${props.providerID}`}
      options={options()}
      current={accounts().find((item) => item.active)?.id}
      actions={[
        {
          command: "provider.account.add",
          title: "Add",
          onTrigger: (): void => void add(),
        },
        {
          command: "provider.account.pin",
          title: "Use here",
          disabled: (option) => !session() || !option || option.value === "add",
          onTrigger: (option): void => void pin(String(option.value)),
        },
        {
          command: "provider.account.rename",
          title: "Rename",
          disabled: (option) => !option || option.value === "add",
          onTrigger: (option): void => void rename(String(option.value)),
        },
        {
          command: "provider.account.remove",
          title: "Remove",
          disabled: (option) => !option || option.value === "add",
          onTrigger: (option): void => void confirmRemove(String(option.value)),
        },
      ]}
    />
  )
}
