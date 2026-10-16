import { describe, expect } from "bun:test"
import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node])))
const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-headless")
const owned = (socket: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: "stale",
    refresh: "old",
    expires: 1,
    metadata: { miaoCredentialSocket: socket },
  })

describe("daemon-owned credential", () => {
  it.live("resolves through its owner without invoking the TS OAuth refresh implementation", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      let localRefreshes = 0
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Device" },
          authorize: () => Effect.never,
          refresh: () =>
            Effect.sync(() => {
              localRefreshes++
              return owned("wrong")
            }),
        }),
      )
      const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "miao-owner-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
      const socket = path.join(directory, "owner.sock")
      let remoteReads = 0
      const server = createServer((connection) => {
        let input = ""
        connection.on("data", (chunk) => {
          input += chunk.toString()
          if (!input.includes("\n")) return
          const request = JSON.parse(input.slice(0, input.indexOf("\n")))
          remoteReads++
          expect(request.op).toBe("get")
          expect(request.integration).toBe("openai")
          connection.end(
            JSON.stringify({
              id: request.id,
              ok: {
                integration: "openai",
                credential: { ...owned(socket), access: "fresh", expires: Date.now() + 3600000 },
              },
            }) + "\n",
          )
        })
      })
      yield* Effect.promise<void>(
        () =>
          new Promise((resolve, reject) => {
            server.once("error", reject)
            server.listen(socket, resolve)
          }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise<void>(() => new Promise((resolve) => server.close(() => resolve()))),
      )
      const credential = yield* credentials.create({ integrationID, value: owned(socket) })
      const connection = { type: "credential" as const, id: credential.id, label: credential.label, active: credential.active }
      const value = yield* integrations.connection.resolve(connection)
      expect(value?.type === "oauth" ? value.access : undefined).toBe("fresh")
      expect(localRefreshes).toBe(0)
      expect(remoteReads).toBe(1)
      // Reading through the owner does not make the TS broker a writer.
      expect((yield* credentials.get(credential.id))?.value).toEqual(owned(socket))
    }),
  )

  it.live("refuses local mutation, activation, deletion and replacement of an owned identity", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const credential = yield* credentials.create({ integrationID, value: owned("/unused/owner.sock") })
      expect(
        Exit.isFailure(yield* credentials.update(credential.id, { value: owned("changed") }).pipe(Effect.exit)),
      ).toBe(true)
      expect(Exit.isFailure(yield* credentials.activate(credential.id).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* credentials.remove(credential.id).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* credentials.create({ integrationID, value: owned("replacement") }).pipe(Effect.exit)),
      ).toBe(true)
      expect((yield* credentials.get(credential.id))?.value).toEqual(owned("/unused/owner.sock"))
    }),
  )
  it.live("does not fall back to the TS broker when the owner is unavailable", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      let refreshes = 0
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Device" },
          authorize: () => Effect.never,
          refresh: () =>
            Effect.sync(() => {
              refreshes++
              return owned("must-not-run")
            }),
        }),
      )
      const credential = yield* credentials.create({ integrationID, value: owned("/missing/miao-owner.sock") })
      const result = yield* integrations.connection
        .resolve({
          type: "credential",
          id: credential.id,
          label: credential.label,
          active: credential.active,
        })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(Integration.AuthorizationError)
      expect(refreshes).toBe(0)
    }),
  )
})
