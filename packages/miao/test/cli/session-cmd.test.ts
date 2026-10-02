import { describe, expect } from "bun:test"
import { inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionTable } from "@miao/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { removeSession } from "../../src/cli/cmd/session"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

describe("miao session delete", () => {
  it.instance("removes a V2 session together with its subagent sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const ctx = yield* InstanceRef
      if (!ctx) throw new Error("no instance")
      const ids = ["ses_cmd_root", "ses_cmd_child", "ses_cmd_grandchild", "ses_cmd_other"].map((id) =>
        SessionV2.ID.make(id),
      )
      const [root, child, grandchild, other] = ids
      yield* db
        .insert(SessionTable)
        .values(
          [
            [root, undefined],
            [child, root],
            [grandchild, child],
            [other, undefined],
          ].map(([id, parent]) => ({
            id: id as SessionV2.ID,
            parent_id: parent,
            project_id: ctx.project.id,
            slug: id as string,
            directory: ctx.directory,
            title: id as string,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)

      yield* removeSession(root).pipe(
        Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
      )

      const left = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(inArray(SessionTable.id, ids))
        .all()
        .pipe(Effect.orDie)
      expect(left.map((row) => row.id)).toEqual([other])

      const missing = yield* removeSession(root).pipe(
        Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
        Effect.flip,
      )
      expect(missing._tag).toBe("Session.NotFoundError")
    }),
  )
})
