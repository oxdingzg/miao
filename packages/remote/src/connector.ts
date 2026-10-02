// A connector bundles everything one IM network needs: how to log in, how to
// turn saved credentials into a running Channel, and what the network allows.
// Interfaces (CLI, TUI, the daemon's HTTP routes) only render login steps, so a
// new IM never needs interface changes.
import type { Capabilities, Channel } from "./channel"

export type LoginField = {
  readonly key: string
  readonly label: string
  /** Rendered masked and never echoed back. */
  readonly secret?: boolean
  readonly optional?: boolean
  readonly placeholder?: string
}

/** What a connector's login yields. `done` is the last step and carries the credentials. */
export type LoginStep =
  | { readonly type: "qr"; readonly content: string; readonly hint?: string }
  /** Waits for a short code the user reads off their phone; resumes with a string. */
  | { readonly type: "code"; readonly prompt: string }
  /** Waits for the listed fields; resumes with a record keyed by field key. */
  | { readonly type: "form"; readonly title: string; readonly fields: ReadonlyArray<LoginField> }
  | { readonly type: "open"; readonly url: string; readonly hint?: string }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "done"
      readonly account: AccountInfo
      /** The person allowed to drive sessions. Omitted when the login cannot tell; a pairing code then decides. */
      readonly owner?: string
      readonly credentials: unknown
      readonly message?: string
    }
  | { readonly type: "error"; readonly message: string }

/** Answer to a `code` (string) or `form` (record) step. */
export type LoginInput = string | Readonly<Record<string, string>>

export type AccountInfo = { readonly id: string; readonly label: string }

export type LoginContext = {
  readonly fetch: typeof fetch
  /** Aborted when the user cancels or the flow times out. */
  readonly signal: AbortSignal
  /** Connector settings from `remote.<connector id>` in the global config. */
  readonly options: Readonly<Record<string, unknown>>
  readonly log: (message: string) => void
  readonly now: () => number
  /** Resolves after `ms`, or early when the flow is cancelled. */
  readonly sleep: (ms: number) => Promise<void>
}

export type ConnectContext = {
  readonly account: AccountInfo
  /** The person whose messages are accepted; undefined while pairing is pending. */
  readonly owner: () => string | undefined
  /** Private per-account directory for cursors, sessions, and status. */
  readonly stateDir: string
  readonly options: Readonly<Record<string, unknown>>
  readonly agentVersion: string
  readonly fetch: typeof fetch
  readonly log: (message: string) => void
  readonly now: () => number
  /** Records that the credentials stopped working; the account stays off until a new login. */
  readonly markNeedsLogin: (reason: string) => Promise<void>
}

export type Connector<Credentials = unknown> = {
  readonly kind: typeof ConnectorKind
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Static limits, shown before any account exists. A running channel reports its own. */
  readonly capabilities: Capabilities
  /** How the channel receives messages; only used for wording in status output. */
  readonly transport?: "poll" | "socket" | "webhook"
  /** Shown before login starts, for example a risk notice. */
  readonly notice?: string
  /**
   * Whether the owner is decided by a pairing code. When false, login names the
   * owner (a QR scan identifies who scanned) and re-pairing is not offered.
   */
  readonly pairing?: boolean
  readonly login: (context: LoginContext) => AsyncGenerator<LoginStep, void, LoginInput | undefined>
  /** Validates stored credentials; undefined means they are unusable and a new login is required. */
  readonly parse: (credentials: unknown) => Credentials | undefined
  // Method syntax keeps connectors with different credential types assignable to Connector.
  connect(credentials: Credentials, context: ConnectContext): Channel | Promise<Channel>
  /** A link that opens a chat with the bot prefilled with the pairing code, when the network has one. */
  pairLink?(credentials: Credentials, code: string): string | undefined
}

export const ConnectorKind = "miao.remote.connector@1"

export function defineConnector<Credentials>(connector: Omit<Connector<Credentials>, "kind">): Connector<Credentials> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(connector.id))
    throw new Error(`connector id "${connector.id}" must be lowercase letters, digits, or dashes`)
  return Object.freeze({ ...connector, kind: ConnectorKind })
}

export function isConnector(value: unknown): value is Connector {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<Connector>
  return (
    candidate.kind === ConnectorKind &&
    typeof candidate.id === "string" &&
    typeof candidate.login === "function" &&
    typeof candidate.connect === "function" &&
    typeof candidate.parse === "function"
  )
}

/** Every connector a module exports: its default export, named exports, or an array of either. */
export function connectorsOf(module: unknown): Connector[] {
  if (typeof module !== "object" || module === null) return []
  return Object.values(module).flatMap((value) =>
    Array.isArray(value) ? value.filter(isConnector) : isConnector(value) ? [value] : [],
  )
}

/**
 * Adapts a callback-style login (show / ask / say) into login steps, so an
 * existing login routine becomes a connector login without being rewritten.
 */
export async function* callbackLogin<Result>(
  run: (io: {
    readonly show: (step: Exclude<LoginStep, { type: "done" | "code" | "form" }>) => void
    readonly ask: (prompt: string) => Promise<string>
  }) => Promise<Result>,
  finish: (result: Result) => LoginStep,
): AsyncGenerator<LoginStep, void, LoginInput | undefined> {
  const queue: Array<{ step: LoginStep; answer?: (value: string) => void }> = []
  const state = { wake: undefined as (() => void) | undefined }
  const push = (item: { step: LoginStep; answer?: (value: string) => void }) => {
    queue.push(item)
    state.wake?.()
  }
  void run({
    show: (step) => push({ step }),
    ask: (prompt) => new Promise<string>((resolve) => push({ step: { type: "code", prompt }, answer: resolve })),
  }).then(
    (result) => push({ step: finish(result) }),
    (error: unknown) =>
      push({ step: { type: "error", message: error instanceof Error ? error.message : String(error) } }),
  )
  while (true) {
    if (queue.length === 0) await new Promise<void>((resolve) => (state.wake = resolve))
    state.wake = undefined
    const item = queue.shift()
    if (!item) continue
    const input = yield item.step
    if (item.answer) item.answer(typeof input === "string" ? input : "")
    if (item.step.type === "done" || item.step.type === "error") return
  }
}
