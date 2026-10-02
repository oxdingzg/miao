// The credentials file (`remote-auth.json`, 0600) holds every connected IM
// account as { <connector id>: { <account id>: AccountRecord } }. Each account
// also gets a private state directory for cursors, sessions, and status.
//
// Before connectors existed the file held one WeChat login as { wechat:
// Credentials } and WeChat state sat in flat `wechat-<bot>.*` files. Reads accept
// that shape; `migrate` rewrites it, moves the state files, and renames the
// router's per-user keys so numbering and held results survive.
import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { readJson, writePrivate } from "./file"

export type AccountRecord = {
  readonly label: string
  /** The only person whose messages are accepted. */
  readonly owner?: string
  /** One-time pairing code, present while no owner is known. */
  readonly pair?: { readonly code: string; readonly expiresAt: number }
  /** Set when the network rejected the credentials; the account stays off until a new login. */
  readonly needsLogin?: { readonly at: number; readonly reason: string }
  readonly savedAt: number
  readonly credentials: unknown
}

export type Accounts = Readonly<Record<string, Readonly<Record<string, AccountRecord>>>>

export async function readAccounts(file: string): Promise<Accounts> {
  const value = await readJson(file)
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).map(([connector, accounts]): [string, Record<string, AccountRecord>] => {
      const legacy = legacyWechat(connector, accounts)
      if (legacy) return [connector, { [legacy.id]: legacy.record }]
      if (typeof accounts !== "object" || accounts === null) return [connector, {}]
      return [
        connector,
        Object.fromEntries(
          Object.entries(accounts).filter((entry): entry is [string, AccountRecord] => isRecord(entry[1])),
        ),
      ]
    }),
  )
}

// Serializes read-modify-write cycles within this process; one writer per file.
const chains = new Map<string, Promise<unknown>>()

/** Applies `change` to one account and writes the file. Returning undefined removes the account. */
export function updateAccount(
  file: string,
  connector: string,
  account: string,
  change: (current: AccountRecord | undefined) => AccountRecord | undefined,
) {
  const run = (chains.get(file) ?? Promise.resolve()).then(async () => {
    const accounts = await readAccounts(file)
    const current = accounts[connector]?.[account]
    const next = change(current)
    const others = Object.fromEntries(Object.entries(accounts[connector] ?? {}).filter(([id]) => id !== account))
    const merged = next ? { ...others, [account]: next } : others
    await writePrivate(file, { ...accounts, [connector]: merged })
    return next
  })
  chains.set(
    file,
    run.catch(() => undefined),
  )
  return run
}

/** The Router's channel ID for one account. The Router splits user keys on the first ":". */
export function channelID(connector: string, account: string) {
  return `${connector}/${account.replaceAll(":", "_")}`
}

/** The private directory of one account. Account ids may contain characters unsafe in paths. */
export function accountDirectory(stateDir: string, connector: string, account: string) {
  return path.join(stateDir, connector, safeName(account))
}

/**
 * Rewrites the single-WeChat layout into the connector layout. Safe to run on
 * every start: it does nothing once the file is in the new shape.
 */
export async function migrate(input: { readonly authFile: string; readonly stateDir: string }) {
  const value = await readJson(input.authFile)
  if (typeof value !== "object" || value === null) return false
  const legacy = legacyWechat("wechat", (value as Record<string, unknown>).wechat)
  if (!legacy) return false
  const directory = accountDirectory(input.stateDir, "wechat", legacy.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const base = path.join(input.stateDir, `wechat-${safeName(legacy.id)}`)
  await Promise.all(
    ["cursor.json", "tokens.json", "status.json"].map((name) =>
      rename(`${base}.${name}`, path.join(directory, name)).catch(() => undefined),
    ),
  )
  const routerFile = path.join(input.stateDir, "router.json")
  const router = await readJson(routerFile)
  if (typeof router === "object" && router !== null) {
    const rekey = (key: string) =>
      key.startsWith("wechat:") ? `${channelID("wechat", legacy.id)}:${key.slice(7)}` : key
    const state = router as { users?: Record<string, unknown>; sessions?: Record<string, { driver?: string }> }
    await writePrivate(routerFile, {
      ...state,
      users: Object.fromEntries(Object.entries(state.users ?? {}).map(([key, user]) => [rekey(key), user])),
      sessions: Object.fromEntries(
        Object.entries(state.sessions ?? {}).map(([id, session]) => [
          id,
          session.driver ? { ...session, driver: rekey(session.driver) } : session,
        ]),
      ),
    })
  }
  await writePrivate(input.authFile, { ...value, wechat: { [legacy.id]: legacy.record } })
  return true
}

function legacyWechat(connector: string, value: unknown) {
  if (connector !== "wechat" || typeof value !== "object" || value === null) return undefined
  const old = value as {
    token?: unknown
    botID?: unknown
    userID?: unknown
    baseUrl?: unknown
    savedAt?: unknown
    needsLogin?: AccountRecord["needsLogin"]
  }
  if (typeof old.token !== "string" || typeof old.botID !== "string" || typeof old.userID !== "string") return undefined
  const savedAt = typeof old.savedAt === "number" ? old.savedAt : 0
  return {
    id: old.botID,
    record: {
      label: "微信 ClawBot",
      owner: old.userID,
      savedAt,
      ...(old.needsLogin ? { needsLogin: old.needsLogin } : {}),
      credentials: { token: old.token, botID: old.botID, baseUrl: old.baseUrl, userID: old.userID, savedAt },
    } satisfies AccountRecord,
  }
}

function isRecord(value: unknown): value is AccountRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<AccountRecord>
  return typeof record.label === "string" && "credentials" in record
}

// Same character set the pre-connector WeChat state files used, so migrated names line up.
function safeName(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_")
  return /^\.*$/.test(cleaned) ? `_${cleaned}` : cleaned
}
