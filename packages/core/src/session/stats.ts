export * as SessionStats from "./stats"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ModelUsage {
  messages: number
  tokens: { input: number; output: number; cache: { read: number; write: number } }
  cost: number
}

export interface Result {
  /** Root sessions in range; subagent sessions count toward their root. */
  readonly sessions: number
  readonly messages: number
  readonly cost: number
  readonly tokens: Tokens
  readonly tools: Record<string, number>
  readonly models: Record<string, ModelUsage>
  readonly earliest: number
  readonly latest: number
  /** Total tokens of each root session's tree, in no particular order. */
  readonly perSession: ReadonlyArray<number>
}

export interface Options {
  /** Only root sessions updated at or after this epoch millisecond. */
  readonly since?: number
  readonly projectID?: string
}

/**
 * Usage across root sessions, read from the V2 projection. The session row's
 * `cost` / `tokens_*` columns cannot be summed: a V2 subagent step is applied to
 * the child and every ancestor, while a backfilled legacy session only carries
 * its own messages. Summing each tree's projected assistant messages counts every
 * provider call exactly once whichever runtime wrote it.
 */
export const aggregate = (db: Database.Interface["db"], options: Options = {}) =>
  Effect.gen(function* () {
    const rows = yield* db
      .all<{
        id: string
        parent_id: string | null
        project_id: string
        time_created: number
        time_updated: number
      }>(sql`SELECT id, parent_id, project_id, time_created, time_updated FROM session`)
      .pipe(Effect.orDie)
    const known = new Set(rows.map((row) => row.id))
    const children = Map.groupBy(
      rows.filter((row) => row.parent_id !== null && known.has(row.parent_id)),
      (row) => row.parent_id as string,
    )
    // A child whose parent was deleted has nobody to roll up into.
    const roots = rows
      .filter((row) => row.parent_id === null || !known.has(row.parent_id))
      .filter((row) => options.since === undefined || row.time_updated >= options.since)
      .filter((row) => options.projectID === undefined || row.project_id === options.projectID)

    const usage = yield* sessionUsage(db)
    const models: Record<string, ModelUsage> = {}
    const tools: Record<string, number> = {}
    const tokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const perSession: number[] = []
    let messages = 0
    let cost = 0

    for (const root of roots) {
      let total = 0
      for (const id of tree(root.id, children)) {
        const session = usage.get(id)
        if (!session) continue
        messages += session.messages
        for (const [key, model] of Object.entries(session.models)) {
          const target = (models[key] ??= {
            messages: 0,
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          })
          target.messages += model.messages
          target.cost += model.cost
          target.tokens.input += model.tokens.input
          target.tokens.output += model.tokens.output + model.tokens.reasoning
          target.tokens.cache.read += model.tokens.cache.read
          target.tokens.cache.write += model.tokens.cache.write
          cost += model.cost
          tokens.input += model.tokens.input
          tokens.output += model.tokens.output
          tokens.reasoning += model.tokens.reasoning
          tokens.cache.read += model.tokens.cache.read
          tokens.cache.write += model.tokens.cache.write
          total +=
            model.tokens.input +
            model.tokens.output +
            model.tokens.reasoning +
            model.tokens.cache.read +
            model.tokens.cache.write
        }
        for (const [name, count] of Object.entries(session.tools)) tools[name] = (tools[name] ?? 0) + count
      }
      perSession.push(total)
    }

    return {
      sessions: roots.length,
      messages,
      cost,
      tokens,
      tools,
      models,
      earliest: roots.reduce(
        (min, row) => Math.min(min, options.since === undefined ? row.time_created : row.time_updated),
        Date.now(),
      ),
      latest: roots.reduce((max, row) => Math.max(max, row.time_updated), 0),
      perSession,
    } satisfies Result
  })

function tree(rootID: string, children: Map<string, ReadonlyArray<{ id: string }>>) {
  const seen = new Set<string>()
  const queue = [rootID]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(children.get(id) ?? []).map((child) => child.id))
  }
  return seen
}

type SessionUsage = {
  messages: number
  models: Record<string, ModelUsage & { tokens: Tokens }>
  tools: Record<string, number>
}

/**
 * Per-session totals computed in SQLite so a large history is never decoded:
 * assistant rows carry the tool outputs that dominate the table's size.
 */
const sessionUsage = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const counts = yield* db
      .all<{
        session_id: string
        n: number
      }>(sql`SELECT session_id, COUNT(*) AS n FROM session_message WHERE type IN ('user', 'assistant') GROUP BY session_id`)
      .pipe(Effect.orDie)
    const models = yield* db
      .all<{
        session_id: string
        provider: string | null
        model: string | null
        n: number
        cost: number | null
        input: number | null
        output: number | null
        reasoning: number | null
        cache_read: number | null
        cache_write: number | null
      }>(
        sql`SELECT session_id,
              json_extract(data, '$.model.providerID') AS provider,
              json_extract(data, '$.model.id') AS model,
              COUNT(*) AS n,
              SUM(json_extract(data, '$.cost')) AS cost,
              SUM(json_extract(data, '$.tokens.input')) AS input,
              SUM(json_extract(data, '$.tokens.output')) AS output,
              SUM(json_extract(data, '$.tokens.reasoning')) AS reasoning,
              SUM(json_extract(data, '$.tokens.cache.read')) AS cache_read,
              SUM(json_extract(data, '$.tokens.cache.write')) AS cache_write
            FROM session_message
            WHERE type = 'assistant'
            GROUP BY session_id, provider, model`,
      )
      .pipe(Effect.orDie)
    const tools = yield* db
      .all<{ session_id: string; name: string; n: number }>(
        sql`SELECT m.session_id AS session_id, json_extract(c.value, '$.name') AS name, COUNT(*) AS n
            FROM session_message m, json_each(m.data, '$.content') c
            WHERE m.type = 'assistant' AND json_extract(c.value, '$.type') = 'tool'
            GROUP BY m.session_id, name`,
      )
      .pipe(Effect.orDie)

    const result = new Map<string, SessionUsage>()
    const entry = (id: string) => {
      const existing = result.get(id)
      if (existing) return existing
      const created: SessionUsage = { messages: 0, models: {}, tools: {} }
      result.set(id, created)
      return created
    }
    for (const row of counts) entry(row.session_id).messages = row.n
    for (const row of models)
      entry(row.session_id).models[`${row.provider ?? "unknown"}/${row.model ?? "unknown"}`] = {
        messages: row.n,
        cost: row.cost ?? 0,
        tokens: {
          input: row.input ?? 0,
          output: row.output ?? 0,
          reasoning: row.reasoning ?? 0,
          cache: { read: row.cache_read ?? 0, write: row.cache_write ?? 0 },
        },
      }
    for (const row of tools) entry(row.session_id).tools[row.name] = row.n
    return result
  })
