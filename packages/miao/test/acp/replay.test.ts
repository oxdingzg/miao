// History replay through the V2 ACP adapter: long V2 sessions, legacy (V1-only)
// sessions before and after `miao db backfill`, and a compacted database.
import { AbsolutePath } from "@miao/schema/schema"
import { Model } from "@miao/schema/model"
import { Provider } from "@miao/schema/provider"
import { SessionID } from "@miao/schema/session-id"
import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { copyFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@miao/client"
import { Effect } from "effect"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { verifierConfig } from "../cli/acp/helpers"
import { connect } from "./harness"

const turns = 225

describe("acp V2 replay", () => {
  cliIt.live(
    "replays every message of a 450-message V2 session",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({ env: { MIAO_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) } })
        const v2 = OpenCode.make({ baseUrl: server.url })
        const session = yield* Effect.promise(() =>
          v2.sessions.create({
            location: { directory: AbsolutePath.make(home) },
            model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
          }),
        )
        // Admitted without running, then promoted together by the last prompt's drain.
        for (const index of Array.from({ length: 449 }, (_, index) => index))
          yield* Effect.promise(() =>
            v2.sessions.prompt({ sessionID: session.id, prompt: { text: `message ${index}` }, resume: false }),
          )
        yield* llm.text("all received")
        yield* Effect.promise(() => v2.sessions.prompt({ sessionID: session.id, prompt: { text: "message 449" } }))
        yield* Effect.promise(() => v2.sessions.wait({ sessionID: session.id }))
        expect(yield* Effect.promise(() => countMessages(v2, session.id))).toBe(451)

        const acp = yield* connect(server.url)
        yield* Effect.promise(() => acp.conn.loadSession({ sessionId: session.id, cwd: home, mcpServers: [] }))
        const users = acp.of(session.id, "user_message_chunk")
        expect(users.length).toBe(450)
        expect(users.map((item) => (item.content.type === "text" ? item.content.text : ""))).toEqual(
          Array.from({ length: 450 }, (_, index) => `message ${index}`),
        )
        expect(acp.text(session.id, "agent_message_chunk")).toBe("all received")
      }),
    120_000,
  )

  cliIt.live(
    "replays legacy sessions before and after backfill, and on a compacted database",
    (fixture) =>
      Effect.gen(function* () {
        const original = path.join(fixture.home, "original.db")
        const compacted = path.join(fixture.home, "compacted.db")

        // A V2 session with one turn, and the project row a legacy session can belong to.
        const first = yield* start(fixture, original)
        const v2 = OpenCode.make({ baseUrl: first.url })
        const modern = yield* Effect.promise(() =>
          v2.sessions.create({
            location: { directory: AbsolutePath.make(fixture.home) },
            model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
          }),
        )
        yield* fixture.llm.text("modern answer")
        yield* Effect.promise(() => v2.sessions.prompt({ sessionID: modern.id, prompt: { text: "modern question" } }))
        yield* Effect.promise(() => v2.sessions.wait({ sessionID: modern.id }))
        yield* stop(first)

        const legacyID = "ses_legacyacpreplay0001"
        seedLegacy(original, { sessionID: legacyID, projectID: modern.projectID, directory: fixture.home })

        // Startup backfills legacy sessions automatically, so the server replays it from the V2 projection.
        const second = yield* start(fixture, original)
        yield* expectLegacyReplay(second.url, fixture.home, legacyID)
        yield* stop(second)

        const backfill = yield* fixture.opencode.spawn(["db", "backfill"], { env: { MIAO_DB: original } })
        fixture.opencode.expectExit(backfill, 0, "db backfill")
        // The automatic startup backfill already migrated the session, so the manual run has nothing left.
        expect(backfill.stdout).toContain("backfilled 0 session(s)")

        checkpoint(original)
        yield* Effect.promise(() => copyFile(original, compacted))
        const compact = yield* fixture.opencode.spawn(["db", "compact", "--yes"], { env: { MIAO_DB: compacted } })
        fixture.opencode.expectExit(compact, 0, "db compact")
        const tables = new Database(compacted, { readonly: true })
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part')")
          .all()
        expect(tables).toEqual([])

        // Backfilled and compacted: the same history, now from the projection only.
        const third = yield* start(fixture, compacted)
        const acp = yield* expectLegacyReplay(third.url, fixture.home, legacyID)
        yield* Effect.promise(() => acp.conn.loadSession({ sessionId: modern.id, cwd: fixture.home, mcpServers: [] }))
        expect(acp.text(modern.id, "user_message_chunk")).toBe("modern question")
        expect(acp.text(modern.id, "agent_message_chunk")).toBe("modern answer")

        // The migrated legacy session keeps going on V2.
        yield* fixture.llm.text("continued on V2")
        const continued = yield* Effect.promise(() =>
          acp.conn.prompt({ sessionId: legacyID, prompt: [{ type: "text", text: "and now?" }] }),
        )
        expect(continued.stopReason).toBe("end_turn")
        expect(acp.text(legacyID, "agent_message_chunk")).toEndWith("continued on V2")

        // The database has one process owner. Close the embedded server before
        // the stdio adapter starts its persistent Runtime for this same store.
        yield* stop(third)

        // The real `miao acp` command over stdio, on the compacted database.
        const stdio = yield* fixture.opencode.acp({
          env: { MIAO_DB: compacted, MIAO_CONFIG_CONTENT: JSON.stringify(verifierConfig(fixture.llm.url)) },
        })
        yield* stdio.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
        yield* stdio.send({
          jsonrpc: "2.0",
          id: 2,
          method: "session/load",
          params: { sessionId: legacyID, cwd: fixture.home, mcpServers: [] },
        })
        const replayed = yield* collectUntil(stdio.receive, 2)
        expect(replayed.response).toMatchObject({ id: 2, result: { configOptions: expect.any(Array) } })
        expect(replayed.kinds.user_message_chunk).toBe(turns + 1)
        expect(replayed.kinds.tool_call).toBe(turns)
      }),
    180_000,
  )
})

/** Reads JSON-RPC lines until the response with `id`, counting `session/update` kinds on the way. */
function collectUntil(receive: Effect.Effect<unknown>, id: number) {
  return Effect.gen(function* () {
    const kinds: Record<string, number> = {}
    while (true) {
      const message = (yield* receive.pipe(Effect.timeout("30 seconds"))) as {
        id?: number
        method?: string
        params?: { update?: { sessionUpdate?: string } }
      }
      if (message.id === id) return { response: message, kinds }
      const kind = message.method === "session/update" ? message.params?.update?.sessionUpdate : undefined
      if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1
    }
  })
}

function start(fixture: CliFixture, db: string) {
  return fixture.opencode.serve({
    env: { MIAO_DB: db, MIAO_CONFIG_CONTENT: JSON.stringify(verifierConfig(fixture.llm.url)) },
  })
}

function stop(server: { kill: () => void; exited: Promise<number> }) {
  return Effect.promise(() => {
    server.kill()
    return server.exited
  })
}

function expectLegacyReplay(url: string, cwd: string, sessionId: string) {
  return Effect.gen(function* () {
    const acp = yield* connect(url)
    yield* Effect.promise(() => acp.conn.loadSession({ sessionId, cwd, mcpServers: [] }))
    expect(acp.of(sessionId, "user_message_chunk").length).toBe(turns)
    expect(acp.of(sessionId, "agent_thought_chunk").length).toBe(turns)
    expect(acp.of(sessionId, "agent_message_chunk").length).toBe(turns)
    expect(acp.of(sessionId, "tool_call").length).toBe(turns)
    expect(acp.of(sessionId, "tool_call_update").filter((update) => update.status === "completed").length).toBe(turns)
    expect(acp.of(sessionId, "user_message_chunk")[0]?.content).toEqual({ type: "text", text: "question 0" })
    expect(acp.text(sessionId, "agent_message_chunk")).toEndWith(`answer ${turns - 1}`)
    return acp
  })
}

async function countMessages(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  cursor?: string,
): Promise<number> {
  const page = await client.messages.list({
    sessionID: SessionID.make(sessionID),
    limit: 200,
    ...(cursor ? { cursor } : { order: "asc" as const }),
  })
  if (page.data.length < 200 || !page.cursor.next) return page.data.length
  return page.data.length + (await countMessages(client, sessionID, page.cursor.next))
}

/** Writes a V1-only session the way the V1 runtime stored it: `message` and `part` rows, no projection. */
function seedLegacy(file: string, input: { sessionID: string; projectID: string; directory: string }) {
  const db = new Database(file)
  const base = 1_700_000_000_000
  db.run(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [input.sessionID, input.projectID, "legacy", input.directory, "legacy session", "0.0.1", base, base],
  )
  const message = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  )
  const part = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  )
  db.transaction(() => {
    for (const index of Array.from({ length: turns }, (_, index) => index)) {
      const at = base + index * 10
      const id = String(index).padStart(4, "0")
      const user = `msg_legacy${id}a`
      const assistant = `msg_legacy${id}b`
      message.run(
        user,
        input.sessionID,
        at,
        at,
        JSON.stringify({
          role: "user",
          time: { created: at },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        }),
      )
      part.run(
        `prt_legacy${id}a`,
        user,
        input.sessionID,
        at,
        at,
        JSON.stringify({ type: "text", text: `question ${index}` }),
      )
      message.run(
        assistant,
        input.sessionID,
        at + 1,
        at + 5,
        JSON.stringify({
          role: "assistant",
          time: { created: at + 1, completed: at + 5 },
          parentID: user,
          modelID: "test-model",
          providerID: "test",
          mode: "build",
          agent: "build",
          path: { cwd: input.directory, root: input.directory },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }),
      )
      part.run(
        `prt_legacy${id}b`,
        assistant,
        input.sessionID,
        at + 1,
        at + 1,
        JSON.stringify({
          type: "reasoning",
          text: `thinking ${index}`,
          time: { start: at + 1, end: at + 2 },
        }),
      )
      part.run(
        `prt_legacy${id}c`,
        assistant,
        input.sessionID,
        at + 2,
        at + 2,
        JSON.stringify({
          type: "tool",
          callID: `call_${index}`,
          tool: "bash",
          state: {
            status: "completed",
            input: { command: `echo ${index}` },
            output: `${index}\n`,
            title: `echo ${index}`,
            metadata: {},
            time: { start: at + 2, end: at + 3 },
          },
        }),
      )
      part.run(
        `prt_legacy${id}d`,
        assistant,
        input.sessionID,
        at + 3,
        at + 3,
        JSON.stringify({ type: "text", text: `answer ${index}` }),
      )
    }
  })()
  db.close()
}

/** Folds the WAL into the main file so a plain copy carries every committed row. */
function checkpoint(file: string) {
  const db = new Database(file)
  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
}
