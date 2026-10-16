import type { CredentialsListOutput } from "@miao/client"
import { ButtonV2 } from "@miao/ui/v2/button-v2"
import { Tag } from "@miao/ui/v2/badge-v2"
import { useDialog } from "@miao/ui/context/dialog"
import { ProviderIcon } from "@miao/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createMemo, createResource, type Accessor, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { removeProviderCredentials } from "@/utils/server"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]
type CredentialAccount = CredentialsListOutput["data"][number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.miao.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.miaoGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{
  directory: Accessor<string | undefined>
  onBack?: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders(props.directory)
  const providerConnect = useProviderConnectController({ onBack: props.onBack })

  const [credentials, refreshCredentials] = createResource(
    () => serverSdk().api,
    (api) => api.credentials.list().then((result) => result.data),
  )

  const accounts = (providerID: string) =>
    (credentials.latest ?? []).filter((account) => account.integrationID === providerID)

  const refreshAccounts = async () => {
    await serverSync().refreshProviders().catch(() => undefined)
    await refreshCredentials.refetch()
  }

  const accountError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const useAccount = (providerName: string, account: CredentialAccount) =>
    serverSdk()
      .api.credentials.activate({ credentialID: account.id })
      .then(() => refreshAccounts())
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.providers.accounts.activated.title"),
          description: language.t("settings.providers.accounts.activated.description", {
            provider: providerName,
            account: account.label,
          }),
        })
      })
      .catch(accountError)

  const removeAccount = (providerName: string, account: CredentialAccount) =>
    serverSdk()
      .api.credentials.remove({ credentialID: account.id })
      .then(() => refreshAccounts())
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.providers.accounts.removed.title"),
          description: language.t("settings.providers.accounts.removed.description", {
            provider: providerName,
            account: account.label,
          }),
        })
      })
      .catch(accountError)

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider directory={props.directory} controller={providerConnect} />)
  }

  const connected = createMemo(() => {
    return providers
      .connected()
      .filter((p) => p.id !== "opencode" || Object.values(p.models).find((m) => m.cost?.input))
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.providers?.[providerID]
    if (!provider) return false
    if (provider.api?.type !== "aisdk" || provider.api.package !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    await serverSync()
      .updateConfig({ providers: { [providerID]: { disabled: true } } })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    if (isConfigCustom(providerID)) {
      await removeProviderCredentials(serverSdk().api, providerID).catch(() => undefined)
      await disableProvider(providerID, name)
      return
    }
    await removeProviderCredentials(serverSdk().api, providerID)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <div class="settings-v2-provider-row group">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name truncate">{item.name}</span>
                        <Tag>{type(item)}</Tag>
                      </div>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="settings-v2-provider-env-hint">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void disconnect(item.id, item.name)}>
                        {language.t("common.disconnect")}
                      </ButtonV2>
                    </Show>
                    <Show when={accounts(item.id).length > 1}>
                      <div class="settings-v2-provider-accounts" data-component="provider-accounts">
                        <span class="settings-v2-provider-accounts-title">
                          {language.t("settings.providers.accounts.title")}
                        </span>
                        <For each={accounts(item.id)}>
                          {(account) => (
                            <div class="settings-v2-provider-account" data-active={account.active || undefined}>
                              <span class="settings-v2-provider-account-label truncate">{account.label}</span>
                              <Show when={account.active}>
                                <Tag>{language.t("settings.providers.accounts.active")}</Tag>
                              </Show>
                              <div class="settings-v2-provider-account-actions">
                                <Show when={!account.active && account.source !== "shared"}>
                                  <ButtonV2
                                    size="normal"
                                    variant="ghost-muted"
                                    onClick={() => void useAccount(item.name, account)}
                                  >
                                    {language.t("settings.providers.accounts.use")}
                                  </ButtonV2>
                                </Show>
                                <Show when={account.source !== "shared"}>
                                  <ButtonV2
                                    size="normal"
                                    variant="ghost-muted"
                                    onClick={() => void removeAccount(item.name, account)}
                                  >
                                    {language.t("settings.providers.accounts.remove")}
                                  </ButtonV2>
                                </Show>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                        <Show when={item.id === "opencode" || item.id === "opencode-go"}>
                          <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                        </Show>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <div class="settings-v2-provider-row" data-component="custom-provider-section">
              <div class="settings-v2-provider-lead">
                <ProviderIcon
                  id="synthetic"
                  width={PROVIDER_ICON_SIZE}
                  height={PROVIDER_ICON_SIZE}
                  class="settings-v2-provider-icon shrink-0"
                />
                <div class="settings-v2-provider-copy">
                  <div class="settings-v2-provider-main">
                    <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                    <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                  </div>
                  <p class="settings-v2-provider-description">{language.t("settings.providers.custom.description")}</p>
                </div>
              </div>
              <ButtonV2
                size="normal"
                variant="neutral"
                icon="plus"
                onClick={() => {
                  dialog.show(() => <DialogCustomProvider onBack={dialog.close} />)
                }}
              >
                {language.t("common.connect")}
              </ButtonV2>
            </div>
          </SettingsListV2>

          <button type="button" class="settings-v2-providers-view-all" onClick={() => connect()}>
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}
