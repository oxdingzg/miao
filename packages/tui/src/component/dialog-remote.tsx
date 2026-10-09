// Configure the relay and authorize App/Web access to the attached Runtime.
import type { OpenCode } from "@miao/client"
import { createContext, useContext } from "solid-js"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useProject } from "../context/project"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSecret } from "../ui/dialog-secret"
import type { RemoteAccess } from "@miao/schema/remote-access"
import { DialogDevices, type DeviceApi } from "./dialog-devices"

export type RemoteRuntime = {
  readonly get: () => Promise<RemoteAccess.Status>
  readonly configure: (value: RemoteAccess.Configuration) => Promise<RemoteAccess.Status>
}
export type RemoteLocal = {
  readonly settings?: () => Promise<{ defaultHubURL?: string; browserURL?: string }>
  readonly providers: (input: { hubURL: string }) => Promise<{ providers: ReadonlyArray<string> }>
  readonly setup: (input: {
    hubURL: string
    email: string
    password: string
    name: string
    runtime: RemoteRuntime
  }) => Promise<RemoteAccess.Status>
  readonly setupOAuth: (input: {
    hubURL: string
    provider: string
    name: string
    runtime: RemoteRuntime
  }) => Promise<RemoteAccess.Status>
}
export type RemoteLocalFactory = () => Promise<RemoteLocal>
const RemoteLocalContext = createContext<RemoteLocalFactory>()
export const RemoteLocalProvider = RemoteLocalContext.Provider

export type RemoteEnvironment = {
  readonly devices: DeviceApi
  readonly setEnabled?: ReturnType<typeof OpenCode.make>["server.runtime"]["setEnabled"]
  readonly setSessionEnabled?: ReturnType<typeof OpenCode.make>["server.runtime"]["setSessionEnabled"]
  readonly configure?: ReturnType<typeof OpenCode.make>["server.runtime"]["configure"]
  readonly sessionID?: string
  readonly projectID?: string
  readonly local?: RemoteLocal
}

const providerTitle = (provider: string) =>
  provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider

export function DialogRemote() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const project = useProject()
  const factory = useContext(RemoteLocalContext)
  const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
  return (
    <DialogRemoteView
      environment={{
        devices: sdk.api["server.runtime"],
        configure: sdk.api["server.runtime"].configure,
        setSessionEnabled: sdk.api["server.runtime"].setSessionEnabled,
        setEnabled: sdk.api["server.runtime"].setEnabled,
        sessionID,
        projectID: sync.data.session.find((session) => session.id === sessionID)?.projectID ?? project.data.project.id,
        local: factory
          ? {
              settings: async () => (await factory()).settings?.() ?? {},
              providers: async (input) => (await factory()).providers(input),
              setup: async (input) => (await factory()).setup(input),
              setupOAuth: async (input) => (await factory()).setupOAuth(input),
            }
          : undefined,
      }}
    />
  )
}

export function DialogRemoteView(props: { environment: RemoteEnvironment }) {
  const environment = props.environment
  const local = environment.local
  const dialog = useDialog()
  const reopen = () => dialog.replace(() => <DialogRemoteView environment={environment} />)
  const runtime: RemoteRuntime | undefined =
    environment.devices && environment.configure
      ? { get: () => environment.devices!.get(), configure: environment.configure! }
      : undefined

  // Runs the login work behind a blocking status alert, then lands on the device
  // list. The error message is already sanitized by the relay client, except the
  // headless "open this link" case which the user needs to read.
  const connect = async (connecting: Promise<RemoteAccess.Status>) => {
    let dismissed = false
    dialog.replace(
      () => <DialogAlert title="连接中继" message="正在登录并在中继上登记这台电脑…" />,
      () => {
        dismissed = true
      },
    )
    try {
      await connecting
      if (dismissed) return
      dialog.replace(() => (
        <DialogDevices api={environment.devices!} sessionID={environment.sessionID} projectID={environment.projectID} />
      ))
    } catch (error) {
      if (dismissed) return
      await DialogAlert.show(
        dialog,
        "配置未确认",
        error instanceof Error
          ? error.message
          : "请检查 Runtime 状态和中继设备目录，再重试。账号凭据不会保存到电脑配置中。",
      )
      reopen()
    }
  }

  const setupOAuth = async (hubURL: string, provider: string, runtime: RemoteRuntime) => {
    const name = await DialogPrompt.show(dialog, "这台电脑的名称", { value: "我的电脑" })
    if (!name) return reopen()
    await connect(local!.setupOAuth({ hubURL, provider, name, runtime }))
  }

  return (
    <DialogSelect
      title="远程遥控"
      options={[
        ...(environment.setEnabled
          ? [
              {
                value: "enable",
                title: "开启当前窗口的远程接入",
                description: "使用保存的中继配置；关闭此窗口后接入结束",
                category: "当前窗口",
                onSelect: () => void connect(environment.setEnabled!({ enabled: true })),
              },
              {
                value: "disable",
                title: "关闭当前窗口的远程接入",
                description: "本地会话继续运行，其他窗口不受影响",
                category: "当前窗口",
                onSelect: () =>
                  void environment.setEnabled!({ enabled: false })
                    .then(reopen)
                    .catch(() => DialogAlert.show(dialog, "关闭失败", "请重试关闭远程接入。")),
              },
            ]
          : []),
        ...(environment.sessionID && environment.setSessionEnabled
          ? [
              {
                value: "session-enable",
                title: "开启当前会话的远程控制",
                category: "当前会话",
                description: "允许已授权设备发现和访问；仍需登录 Hub 并接入窗口",
                onSelect: () =>
                  void environment.setSessionEnabled!({ sessionID: environment.sessionID!, enabled: true })
                    .then(reopen)
                    .catch(() => DialogAlert.show(dialog, "开启失败", "该会话可能正由其他窗口使用，请检查后重试。")),
              },
              {
                value: "session-disable",
                title: "关闭当前会话的远程控制",
                category: "当前会话",
                description: "立即停止远程访问，本地任务继续运行",
                onSelect: () =>
                  void environment.setSessionEnabled!({ sessionID: environment.sessionID!, enabled: false })
                    .then(reopen)
                    .catch(() => DialogAlert.show(dialog, "关闭失败", "请重试关闭当前会话的远程控制。")),
              },
            ]
          : []),
        ...(local?.setup && runtime
          ? [
              {
                value: "relay-setup",
                title: "登录中继并接入",
                category: "设备接入",
                description: "登录中继账号并登记这台电脑，无需重启会话",
                onSelect: () =>
                  void (async () => {
                    const defaults = (await local.settings?.()) ?? {}
                    const configuredHub = defaults.defaultHubURL ?? process.env.MIAO_HUB_URL
                    const choice = configuredHub
                      ? await new Promise<"default" | "custom" | undefined>((resolve) => {
                          dialog.replace(
                            () => (
                              <DialogSelect
                                title="选择 Hub"
                                options={[
                                  {
                                    value: "default",
                                    title: "使用默认 Hub",
                                    description: configuredHub,
                                    onSelect: () => resolve("default"),
                                  },
                                  {
                                    value: "custom",
                                    title: "指定其他 Hub",
                                    description: "登录你选择的公共或自建中继",
                                    onSelect: () => resolve("custom"),
                                  },
                                ]}
                              />
                            ),
                            () => resolve(undefined),
                          )
                        })
                      : "custom"
                    if (!choice) return reopen()
                    const hubURL =
                      choice === "default"
                        ? configuredHub
                        : await DialogPrompt.show(dialog, "中继地址", {
                            placeholder: "https://hub.example.com",
                            value: configuredHub ?? "",
                          })
                    if (!hubURL) return reopen()
                    const discovered = await local.providers({ hubURL })
                    const social = discovered.providers.filter(
                      (provider) => provider === "github" || provider === "google",
                    )
                    if (social.length > 1) {
                      dialog.replace(() => (
                        <DialogSelect
                          title="选择登录方式"
                          options={social.map((provider) => ({
                            value: provider,
                            title: providerTitle(provider),
                            description: "在浏览器中登录中继账号",
                            onSelect: () => void setupOAuth(hubURL, provider, runtime),
                          }))}
                        />
                      ))
                      return
                    }
                    if (social.length === 1) {
                      await setupOAuth(hubURL, social[0]!, runtime)
                      return
                    }
                    const email = await DialogPrompt.show(dialog, "中继账号邮箱")
                    if (!email) return reopen()
                    const name = await DialogPrompt.show(dialog, "这台电脑的名称", { value: "我的电脑" })
                    if (!name) return reopen()
                    let password = await DialogSecret.show(dialog, "中继账号密码")
                    if (password === null) return reopen()
                    const connecting = local.setup({ hubURL, email, password, name, runtime })
                    password = null
                    await connect(connecting)
                  })().catch((error: unknown) =>
                    DialogAlert.show(
                      dialog,
                      "Hub 登录未完成",
                      error instanceof Error ? error.message : "请检查 Hub 配置并重试",
                    ),
                  ),
              },
            ]
          : []),
        ...(environment.devices
          ? [
              {
                value: "devices",
                title: "Web / iOS 设备",
                description: "扫码、批准设备和撤销授权",
                category: "设备接入",
                onSelect: () =>
                  void (async () => {
                    const settings = await local?.settings?.()
                    dialog.replace(() => (
                      <DialogDevices
                        api={environment.devices!}
                        sessionID={environment.sessionID}
                        projectID={environment.projectID}
                        browserURL={settings?.browserURL}
                      />
                    ))
                  })().catch(() => DialogAlert.show(dialog, "无法读取扫码入口", "请检查本地 Hub 客户端配置。")),
              },
            ]
          : []),
      ]}
    />
  )
}
