// Verifies a Zed (ACP) click-through from the recording proxy's log.
//
// The proxy (`~/.local/share/miao/zed/zed-acp-proxy.ts`) appends one line per
// stdio chunk: `<iso> <tag> <json-encoded chunk>` with `C>` for client→agent
// and `A<` for agent→client. JSON-RPC is newline-delimited, so reassembling a
// direction's chunks and splitting on newlines recovers whole messages.
//
// Usage: bun script/acp-ui-acceptance.ts [--log PATH] [--session N]
// A session is one `==== <iso> spawn` block. By default every block is
// aggregated, so approvals from one Zed window and a later reconnect from
// another still produce one verdict.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = Bun.argv.slice(2)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const path = value("--log") ?? join(homedir(), ".local/share/miao/zed/acp-protocol.log")
if (!existsSync(path)) {
  console.error(`no ACP log at ${path}; run a Zed session through the recording proxy first`)
  process.exit(2)
}

interface Session {
  started: string
  cwd: string
  client: string
  agent: string
}

const sessions: Array<Session> = []
for (const line of (await Bun.file(path).text()).split("\n")) {
  const spawn = /^==== (\S+) spawn cwd=(.*)$/.exec(line)
  if (spawn) {
    sessions.push({ started: spawn[1], cwd: spawn[2], client: "", agent: "" })
    continue
  }
  const chunk = /^\S+ (C>|A<) (".*")$/.exec(line)
  if (!chunk || sessions.length === 0) continue
  const session = sessions[sessions.length - 1]
  if (chunk[1] === "C>") session.client += JSON.parse(chunk[2])
  else session.agent += JSON.parse(chunk[2])
}

const selected = value("--session")
const picked = selected === undefined ? sessions : [sessions.at(Number(selected))].filter((s) => s !== undefined)
if (picked.length === 0) {
  console.error(`no spawn session in ${path}`)
  process.exit(2)
}

const messages = (stream: string) =>
  stream
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })

const client = picked.flatMap((session) => messages(session.client))
const agent = picked.flatMap((session) => messages(session.agent))
const method = (message: Record<string, unknown>) => message.method
const requestID = (message: Record<string, unknown>) => message.id

const permissionRequests = agent.filter((message) => method(message) === "session/request_permission")
const permissionReplies = client.flatMap((message) => {
  const id = requestID(message)
  if (id === undefined) return []
  const outcome = (message.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome
  return permissionRequests.some((request) => requestID(request) === id) && outcome
    ? [{ id, outcome: outcome.outcome, optionId: outcome.optionId }]
    : []
})
const cancels = client.filter((message) => method(message) === "session/cancel")
const promptStops = agent.flatMap((message) => {
  const stop = (message.result as { stopReason?: string } | undefined)?.stopReason
  return stop ? [stop] : []
})
const loads = client.filter((message) => method(message) === "session/load" || method(message) === "session/resume")
const replayed = agent.filter((message) => {
  const update = (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update
  return update?.sessionUpdate === "user_message_chunk"
})

// The TypeScript ACP layer names the options once/always/reject; the engine's
// ACP layer uses allow_once/allow_always/reject_once. Accept both.
const allowIDS = new Set(["once", "always", "allow_once", "allow_always"])
const rejectIDS = new Set(["reject", "reject_once"])
const allowed = permissionReplies.filter((reply) => allowIDS.has(reply.optionId ?? "")).length
const rejected = permissionReplies.filter((reply) => rejectIDS.has(reply.optionId ?? "")).length

const checks: Array<[string, boolean, string]> = [
  [
    "approval",
    allowed > 0,
    `${permissionRequests.length} asked, ${allowed} allowed, ${rejected} rejected`,
  ],
  ["denial", rejected > 0, `${rejected} rejected`],
  [
    "cancel",
    cancels.length > 0 && promptStops.includes("cancelled"),
    `${cancels.length} session/cancel, prompt stopReasons=[${promptStops.join(", ")}]`,
  ],
  ["reconnect", loads.length > 0 && replayed.length > 0, `${loads.length} load/resume, ${replayed.length} replayed user chunks`],
]

console.log(`${picked.length} session(s): ${picked.map((session) => session.started).join(", ")}`)
for (const [name, pass, detail] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(9)} ${detail}`)
const failed = checks.filter(([, pass]) => !pass).map(([name]) => name)
if (failed.length > 0) {
  console.log(`\nmissing: ${failed.join(", ")}`)
  process.exit(1)
}
console.log("\nACP UI ACCEPTANCE=PASS")
