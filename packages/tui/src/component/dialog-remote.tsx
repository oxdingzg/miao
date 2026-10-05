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

export type RemoteLocal = {
  readonly setup: (input: {
    hubURL: string
    email: string
    password: string
    name: string
    runtime: {
      get(): Promise<RemoteAccess.Status>
      configure(value: RemoteAccess.Configuration): Promise<RemoteAccess.Status>
    }
  }) => Promise<RemoteAccess.Status>
}
export type RemoteLocalFactory = () => Promise<RemoteLocal>
const RemoteLocalContext = createContext<RemoteLocalFactory>()
export const RemoteLocalProvider = RemoteLocalContext.Provider

export type RemoteEnvironment = {
  readonly devices: DeviceApi
  readonly configure?: ReturnType<typeof OpenCode.make>["server.runtime"]["configure"]
  readonly sessionID?: string
  readonly projectID?: string
  readonly local?: RemoteLocal
}

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
        sessionID,
        projectID: sync.data.session.find((session) => session.id === sessionID)?.projectID ?? project.data.project.id,
        local: factory ? { setup: async (input) => (await factory()).setup(input) } : undefined,
      }}
    />
  )
}

export function DialogRemoteView(props: { environment: RemoteEnvironment }) {
  const environment = props.environment
  const local = environment.local
  const dialog = useDialog()
  const reopen = () => dialog.replace(() => <DialogRemoteView environment={environment} />)
  return (
    <DialogSelect
      title="远程遥控"
      options={[
        ...(local?.setup && environment.devices && environment.configure
          ? [
              {
                value: "relay-setup",
                title: "配置自建中继",
                category: "设备接入",
                description: "登录中继并登记这台电脑，无需重启会话",
                onSelect: () =>
                  void (async () => {
                    const hubURL = await DialogPrompt.show(dialog, "自建中继地址", {
                      placeholder: "https://relay.example.com",
                    })
                    if (!hubURL) {
                      reopen()
                      return
                    }
                    const email = await DialogPrompt.show(dialog, "中继账号邮箱")
                    if (!email) {
                      reopen()
                      return
                    }
                    const name = await DialogPrompt.show(dialog, "这台电脑的名称", { value: "我的电脑" })
                    if (!name) {
                      reopen()
                      return
                    }
                    let password = await DialogSecret.show(dialog, "中继账号密码")
                    if (password === null) {
                      reopen()
                      return
                    }
                    const connecting = local.setup!({
                      hubURL,
                      email,
                      password,
                      name,
                      runtime: { get: () => environment.devices!.get(), configure: environment.configure! },
                    })
                    password = null
                    let dismissed = false
                    dialog.replace(
                      () => <DialogAlert title="连接中继" message="正在登录和登记电脑…" />,
                      () => {
                        dismissed = true
                      },
                    )
                    try {
                      await connecting
                      if (dismissed) return
                      dialog.replace(() => (
                        <DialogDevices
                          api={environment.devices!}
                          sessionID={environment.sessionID}
                          projectID={environment.projectID}
                        />
                      ))
                    } catch {
                      if (dismissed) return
                      await DialogAlert.show(
                        dialog,
                        "配置未确认",
                        "请检查 Runtime 状态和中继设备目录，再重试。账号凭据不会保存到电脑配置中。",
                      )
                      reopen()
                    }
                  })(),
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
                  dialog.replace(() => (
                    <DialogDevices
                      api={environment.devices!}
                      sessionID={environment.sessionID}
                      projectID={environment.projectID}
                    />
                  )),
              },
            ]
          : []),
      ]}
    />
  )
}
