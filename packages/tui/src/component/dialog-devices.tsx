import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { OpenCode } from "@miao/client"
import type { RemoteAccess } from "@miao/schema/remote-access"
import { createHash } from "node:crypto"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { useClipboard } from "../context/clipboard"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

export type DeviceApi = Pick<
  ReturnType<typeof OpenCode.make>["server.runtime"],
  "get" | "invite" | "pending" | "approve" | "reject" | "devices" | "revoke"
>

type Confirmation =
  | { readonly type: "approve"; readonly candidate: RemoteAccess.Candidate }
  | { readonly type: "revoke"; readonly grant: RemoteAccess.Grant }

/** Local owner approval stays in this component so opening a confirmation cannot cancel the invitation. */
export function DialogDevices(props: {
  readonly api: DeviceApi
  readonly sessionID?: string
  readonly projectID?: string
  readonly pollMs?: number
}) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [status, setStatus] = createSignal<RemoteAccess.Status>()
  const [pending, setPending] = createSignal<readonly RemoteAccess.Candidate[]>([])
  const [devices, setDevices] = createSignal<readonly RemoteAccess.Grant[]>([])
  const [invitation, setInvitation] = createSignal<RemoteAccess.Invitation>()
  const [confirmation, setConfirmation] = createSignal<Confirmation>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const lifecycle = { closed: false, refreshing: false }

  const refresh = async () => {
    if (lifecycle.closed || lifecycle.refreshing) return
    lifecycle.refreshing = true
    await props.api
      .get()
      .then(async (value) => {
        const [candidates, grants] = value.enabled
          ? await Promise.all([props.api.pending(), props.api.devices()])
          : [[], []]
        if (lifecycle.closed) return
        if (JSON.stringify(status()) !== JSON.stringify(value)) setStatus(value)
        if (JSON.stringify(pending()) !== JSON.stringify(candidates)) setPending(candidates)
        if (JSON.stringify(devices()) !== JSON.stringify(grants)) setDevices(grants)
        if (invitation() && invitation()!.expiresAt <= Date.now()) {
          const expired = invitation()!
          setInvitation(undefined)
          setNotice("二维码已过期，可重新生成")
          await props.api.reject({ pairingID: expired.pairingID }).catch(() => undefined)
        }
      })
      .catch(() => {
        if (!lifecycle.closed) setError("无法读取远程接入状态，请重试")
      })
      .finally(() => {
        lifecycle.refreshing = false
      })
  }

  const perform = (action: () => Promise<void>) => {
    if (busy() || lifecycle.closed) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void action()
      // SDK errors can contain request bodies; never display invitation secrets from an error.
      .catch(() => {
        if (!lifecycle.closed) setError("操作未完成，请刷新状态后重试")
      })
      .finally(() => {
        if (lifecycle.closed) return
        setBusy(false)
        void refresh()
      })
  }

  const invite = (policy: RemoteAccess.Policy) =>
    perform(async () => {
      const issued = await props.api.invite(policy)
      if (lifecycle.closed) {
        await props.api.reject({ pairingID: issued.pairingID })
        return
      }
      setInvitation(issued)
    })

  onMount(() => {
    dialog.setSize("xlarge")
    void refresh()
  })
  const timer = setInterval(() => void refresh(), props.pollMs ?? 1000)
  onCleanup(() => {
    lifecycle.closed = true
    clearInterval(timer)
    const issued = invitation()
    if (issued) void props.api.reject({ pairingID: issued.pairingID }).catch(() => undefined)
  })

  // The fragment contains the one-time secret. It is never sent in an HTTP URL or printed in a status message.
  const link = createMemo(() => {
    const issued = invitation()
    return issued ? `miao://pair#${Buffer.from(JSON.stringify(issued)).toString("base64url")}` : undefined
  })
  const qr = createMemo(() => {
    const value = link()
    return value ? renderUnicodeCompact(value, { border: 1 }).split("\n") : []
  })
  const fits = createMemo(
    () =>
      (qr()[0]?.length ?? 0) <= dimensions().width - 12 &&
      qr().length + 15 <= dimensions().height - Math.floor(dimensions().height / 4),
  )

  const options = createMemo((): DialogSelectOption<string>[] => {
    const confirm = confirmation()
    if (confirm)
      return [
        { value: "cancel", title: "取消", onSelect: () => setConfirmation(undefined) },
        {
          value: "confirm",
          title: confirm.type === "approve" ? "批准这个设备" : "撤销这个设备",
          onSelect: () =>
            perform(async () => {
              if (confirm.type === "approve") {
                await props.api.approve({
                  pairingID: confirm.candidate.pairingID,
                  publicKey: confirm.candidate.candidate.publicKey,
                })
                if (invitation()?.pairingID === confirm.candidate.pairingID) setInvitation(undefined)
                setNotice("设备已授权")
              }
              if (confirm.type === "revoke") {
                await props.api.revoke({ grantID: confirm.grant.id, version: confirm.grant.version })
                setNotice("设备已撤销；运行中的任务继续执行")
              }
              setConfirmation(undefined)
            }),
        },
      ]
    const current = status()
    if (!current || !current.enabled) return [{ value: "refresh", title: "刷新状态", onSelect: () => perform(refresh) }]
    const issued = invitation()
    const write: RemoteAccess.Permission[] = [
      "read",
      "prompt",
      "permission.reply",
      "question.reply",
      "interrupt",
      "session.rename",
      "session.selection",
    ]
    return [
      ...(issued
        ? [
            ...(clipboard.write
              ? [
                  {
                    value: "copy",
                    title: "复制配对链接",
                    description: "仅交给要接入的设备",
                    onSelect: () =>
                      perform(async () => {
                        await clipboard.write!(link()!)
                        setNotice("配对链接已复制")
                      }),
                  },
                ]
              : []),
            {
              value: "cancel-invitation",
              title: "取消本次配对",
              onSelect: () =>
                perform(async () => {
                  await props.api.reject({ pairingID: issued.pairingID })
                  setInvitation(undefined)
                }),
            },
          ]
        : [
            ...(props.sessionID
              ? [
                  {
                    value: "invite-read",
                    title: "分享当前会话（只读）",
                    description: "授权 1 小时，扫码后仍需本机批准",
                    onSelect: () =>
                      invite({
                        permissions: ["read"],
                        projectIDs: [],
                        sessionIDs: [props.sessionID!],
                        expiresAt: Date.now() + 3_600_000,
                      }),
                  },
                  {
                    value: "invite-control",
                    title: "分享当前会话（可操作）",
                    description: "授权 1 小时，可输入、审批和中断当前执行",
                    onSelect: () =>
                      invite({
                        permissions: write,
                        projectIDs: [],
                        sessionIDs: [props.sessionID!],
                        expiresAt: Date.now() + 3_600_000,
                      }),
                  },
                ]
              : []),
            ...(props.projectID
              ? [
                  {
                    value: "invite-project",
                    title: "持续接入当前项目",
                    description: "授权 7 天，可查看、操作和创建项目内的会话",
                    onSelect: () =>
                      invite({
                        permissions: [...write, "session.create"],
                        projectIDs: [props.projectID!],
                        sessionIDs: [],
                        expiresAt: Date.now() + 7 * 86_400_000,
                      }),
                  },
                ]
              : []),
          ]),
      ...pending().map(
        (candidate): DialogSelectOption<string> => ({
          value: `approve:${candidate.pairingID}`,
          title: label(candidate.candidate.label),
          category: "等待批准",
          description: "核对设备指纹和授权范围",
          onSelect: () => setConfirmation({ type: "approve", candidate }),
        }),
      ),
      ...devices()
        .filter((grant) => grant.revokedAt === null && grant.expiresAt > Date.now())
        .map(
          (grant): DialogSelectOption<string> => ({
            value: `revoke:${grant.id}`,
            title: label(grant.label),
            category: "已授权设备",
            description: `到期 ${new Date(grant.expiresAt).toLocaleString()} · 撤销…`,
            onSelect: () => setConfirmation({ type: "revoke", grant }),
          }),
        ),
      { value: "refresh", title: "刷新状态", onSelect: () => perform(refresh) },
    ]
  })

  const details = createMemo(() => {
    const value = confirmation()
    if (!value) return undefined
    return value.type === "approve"
      ? {
          label: value.candidate.candidate.label,
          publicKey: value.candidate.candidate.publicKey,
          policy: value.candidate.policy,
        }
      : { label: value.grant.label, publicKey: value.grant.publicKey, policy: value.grant }
  })

  return (
    <box gap={1}>
      <box paddingLeft={4} paddingRight={4} gap={1}>
        <text fg={theme.textMuted}>
          {!status()
            ? "正在检查中继连接…"
            : !status()!.enabled
              ? "中继尚未配置"
              : status()!.connected
                ? "中继已连接"
                : "中继连接中；暂时无法扫码接入"}
        </text>
        <Show when={error()}>{(value) => <text fg={theme.error}>{value()}</text>}</Show>
        <Show when={notice()}>{(value) => <text fg={theme.success}>{value()}</text>}</Show>
        <Show when={details()}>
          {(value) => (
            <box gap={1}>
              <text fg={theme.text}>设备：{label(value().label)}</text>
              <text fg={theme.text}>SHA-256 指纹：{fingerprint(value().publicKey)}</text>
              <text fg={theme.textMuted}>权限：{value().policy.permissions.join(", ")}</text>
              <text fg={theme.textMuted}>项目：{value().policy.projectIDs.join(", ") || "无"}</text>
              <text fg={theme.textMuted}>会话：{value().policy.sessionIDs.join(", ") || "项目内全部会话"}</text>
              <text fg={theme.textMuted}>授权到期：{new Date(value().policy.expiresAt).toLocaleString()}</text>
              <text fg={theme.warning}>
                {confirmation()?.type === "approve"
                  ? "名称由设备提供，请在设备上核对指纹后批准"
                  : "撤销会断开设备连接；运行中的任务继续执行"}
              </text>
            </box>
          )}
        </Show>
        <Show when={invitation() && !confirmation()}>
          <text fg={theme.text}>用 miao App 扫码，随后在这里核对并批准设备</text>
          <Show
            when={fits()}
            fallback={<text fg={theme.textMuted}>窗口不足以完整显示二维码，请放大窗口或复制配对链接</text>}
          >
            <box>
              <For each={qr()}>
                {(line) => (
                  <text fg={RGBA.fromHex("#ffffff")} bg={RGBA.fromHex("#000000")}>
                    {line}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <text fg={theme.textMuted}>二维码到期：{new Date(invitation()!.expiresAt).toLocaleTimeString()}</text>
        </Show>
      </box>
      {/* Reset search when issuing or confirming an invitation without disposing its lifecycle. */}
      <Show keyed when={confirmation() ? "确认设备授权" : invitation() ? "扫码配对" : "Web / iOS 设备"}>
        {(title) => (
          <DialogSelect
            title={title}
            options={options()}
            locked={busy()}
            renderFilter={!confirmation()}
            footer={<text fg={theme.textMuted}>{busy() ? "正在处理…" : "关闭窗口会取消尚未批准的本次配对"}</text>}
          />
        )}
      </Show>
    </box>
  )
}

function label(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").slice(0, 128)
}

function fingerprint(publicKey: string) {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url")
}
