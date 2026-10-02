// End-to-end checks for `miao --mini` on the V2 session API: a real HTTP
// server over the test database, the generated SDK client, and a fake LLM.
// One database holds a legacy V1 session (written through the V1 session
// service, then backfilled) and a V2 session driven by the V2 runner.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk/v2"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { FSUtil } from "@miao/core/fs-util"
import { CrossSpawnSpawner } from "@miao/core/cross-spawn-spawner"
import { Database } from "@miao/core/database/database"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionBackfill } from "@miao/core/session/backfill"
import type { SessionV1 } from "@miao/core/v1/session"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, PartID } from "../../../src/session/schema"
import { replaySession } from "@/cli/cmd/run/session-replay"
import { loadTranscript, transcriptEntries } from "@/cli/cmd/run/session-v2"
import { createSessionTransport } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, StreamCommit } from "@/cli/cmd/run/types"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../../fixture/fixture"
import { TestLLMServer } from "../../lib/llm-server"
import { testEffect } from "../../lib/effect"
import { testProviderConfig } from "../../lib/test-provider"
import { httpApiLayer } from "../../server/httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, Session.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

// Every request the client made, to prove the mini paths stay off the V1
// session, permission, and question routes.
const requested: string[] = []
const legacyRoute = /^\/(session|permission|question)(\/|$)/

afterEach(async () => {
  requested.length = 0
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      // The test server listens on 0.0.0.0, which NO_PROXY's loopback entries
      // do not cover, so address it directly.
      const baseUrl =
        server.address._tag === "TcpAddress"
          ? `http://127.0.0.1:${server.address.port}`
          : HttpServer.formatAddress(server.address)
      const fetch = Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          requested.push(url.pathname)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
      return createOpencodeClient({ baseUrl: "http://localhost", directory, fetch })
    }),
  )
}

function footer(onEvent?: (event: FooterEvent) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false
  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event(next) {
      events.push(next)
      onEvent?.(next)
    },
    append(next) {
      commits.push(next)
    },
    idle: () => Promise.resolve(),
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }
  return { api, commits, events }
}

// What a reader sees in scrollback, without the ids that differ between the
// V1 rows and their V2 projection.
function visible(commits: StreamCommit[]) {
  return commits.map((commit) => ({
    kind: commit.kind,
    text: commit.text,
    phase: commit.phase,
    tool: commit.tool,
    toolState: commit.toolState,
    interrupted: commit.interrupted,
  }))
}

const writeLegacySession = (directory: string) =>
  InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      Session.Service.use((svc) =>
        Effect.gen(function* () {
          const info = yield* svc.create({ title: "legacy" })
          const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
          const user = MessageID.ascending()
          yield* svc.updateMessage({
            id: user,
            sessionID: info.id,
            role: "user",
            time: { created: 1_000 },
            agent: "build",
            model,
          } as SessionV1.Info)
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: user,
            type: "text",
            text: "list the files",
          })
          const assistant = MessageID.ascending()
          yield* svc.updateMessage({
            id: assistant,
            sessionID: info.id,
            role: "assistant",
            time: { created: 2_000, completed: 4_500 },
            parentID: user,
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          } as SessionV1.Info)
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: assistant,
            type: "reasoning",
            text: "look first",
            time: { start: 2_000, end: 2_050 },
          })
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: assistant,
            type: "tool",
            callID: "call_ls",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls", description: "list" },
              output: "a.ts\nb.ts\n",
              title: "ls",
              metadata: { exit: 0, output: "a.ts\nb.ts\n", description: "list" },
              time: { start: 2_100, end: 2_200 },
            },
          })
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: assistant,
            type: "tool",
            callID: "call_edit",
            tool: "edit",
            state: {
              status: "completed",
              input: { filePath: `${directory}/a.ts`, oldString: "a", newString: "b" },
              output: "Edit applied successfully.",
              title: "a.ts",
              metadata: { diff: "@@ -1 +1 @@\n-a\n+b\n" },
              time: { start: 2_300, end: 2_400 },
            },
          })
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: info.id,
            messageID: assistant,
            type: "text",
            text: "two files, one edited",
            time: { start: 2_500, end: 4_500 },
          })
          return { id: info.id, v1: yield* svc.messages({ sessionID: info.id }) }
        }),
      ),
    ),
  )

// Cases that boot an in-process server get 30s: a cold first boot on Linux has taken ~5s.
describe("mini on the V2 session API", () => {
  it.live("replays a backfilled legacy session the way the V1 replay did", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
      const legacy = yield* writeLegacySession(directory)
      const replay = (entries: Parameters<typeof replaySession>[0]["entries"]) =>
        replaySession({ sessionID: legacy.id, entries, permissions: [], questions: [], thinking: true, limits: {} })

      // The V1 implementation replayed the V1 rows through the same reducer.
      const before = replay(
        legacy.v1.map((message) => ({
          type: "message" as const,
          message: message as unknown as { info: Message; parts: Part[] },
        })),
      )

      const database = yield* Database.Service
      yield* SessionBackfill.backfill(database.db)
      const sdk = yield* client(directory)
      const messages = yield* Effect.promise(() => loadTranscript(sdk, legacy.id))
      const after = replay(transcriptEntries({ sessionID: legacy.id, directory, messages }))

      expect(visible(after.commits)).toEqual(visible(before.commits))
      expect(after.patch).toEqual(before.patch)
      expect(after.commits.map((commit) => commit.kind)).toEqual([
        "user",
        "reasoning",
        "tool",
        "tool",
        "tool",
        "tool",
        "assistant",
        "system",
      ])
      expect(requested.filter((path) => legacyRoute.test(path))).toEqual([])
    }),
  )

  it.live(
    "streams a V2 turn with a tool call and replays it the same way",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: false, config: testProviderConfig(llm.url) })
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() =>
          sdk.v2.session.create({ location: { directory } }, { throwOnError: true }).then((result) => result.data.data),
        )
        yield* llm.tool("bash", { command: "echo mini-v2" })
        yield* llm.text("all done", { usage: { input: 3, output: 2 } })

        const asked: string[] = []
        const ui = footer((event) => {
          if (event.type !== "stream.view" || event.view.type !== "permission") return
          const request = event.view.request
          asked.push(request.permission)
          void sdk.v2.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply: "once" })
        })
        const transport = yield* Effect.promise(() =>
          createSessionTransport({
            sdk,
            directory,
            sessionID: created.id,
            thinking: true,
            replay: true,
            limits: () => ({}),
            footer: ui.api,
          }),
        )

        yield* Effect.promise(() =>
          transport.runPromptTurn({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            variant: undefined,
            prompt: { text: "run the check", parts: [] },
            files: [],
            includeFiles: false,
          }),
        )
        yield* Effect.promise(() => transport.close())

        const live = ui.commits.filter((commit) => commit.kind !== "user" && commit.kind !== "system")
        expect(live.map((commit) => [commit.kind, commit.tool, commit.toolState, commit.text.trim()])).toEqual([
          ["tool", "bash", "running", "running bash"],
          ["tool", "bash", "completed", "mini-v2"],
          ["assistant", undefined, undefined, "all done"],
        ])
        const done = live[1]?.part
        expect(done?.state.status === "completed" ? done.state.metadata.exit : undefined).toBe(0)

        const messages = yield* Effect.promise(() => loadTranscript(sdk, created.id))
        const replayed = replaySession({
          sessionID: created.id,
          entries: transcriptEntries({ sessionID: created.id, directory, messages }),
          permissions: [],
          questions: [],
          thinking: true,
          limits: {},
        })
        expect(replayed.commits[0]).toEqual(expect.objectContaining({ kind: "user", text: "run the check" }))
        expect(
          visible(replayed.commits.filter((commit) => commit.kind !== "user" && commit.kind !== "system")),
        ).toEqual(visible(live))
        expect(replayed.commits.at(-1)).toEqual(
          expect.objectContaining({ kind: "system", text: expect.stringContaining("Build") }),
        )
        // The bash call may or may not ask, depending on the default rules; either way it was answered.
        expect(asked.every((action) => action === "bash")).toBe(true)
        expect(requested).toContain(`/api/session/${created.id}/prompt`)
        expect(requested.filter((path) => legacyRoute.test(path))).toEqual([])
      }).pipe(Effect.provide(TestLLMServer.layer)),
    30_000,
  )

  it.live(
    "answers a V2 question and settles the question tool",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: false, config: testProviderConfig(llm.url) })
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() =>
          sdk.v2.session.create({ location: { directory } }, { throwOnError: true }).then((result) => result.data.data),
        )
        yield* llm.tool("question", {
          questions: [
            {
              question: "Which mode?",
              header: "Mode",
              options: [
                { label: "fast", description: "Quick pass" },
                { label: "slow", description: "Careful pass" },
              ],
            },
          ],
        })
        yield* llm.text("picked fast")

        const ui = footer((event) => {
          if (event.type !== "stream.view" || event.view.type !== "question") return
          const request = event.view.request
          void sdk.v2.session.question.reply({
            sessionID: request.sessionID,
            requestID: request.id,
            questionV2Reply: { answers: [["fast"]] },
          })
        })
        const transport = yield* Effect.promise(() =>
          createSessionTransport({
            sdk,
            directory,
            sessionID: created.id,
            thinking: true,
            limits: () => ({}),
            footer: ui.api,
          }),
        )
        yield* Effect.promise(() =>
          transport.runPromptTurn({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            variant: undefined,
            prompt: { text: "ask me", parts: [] },
            files: [],
            includeFiles: false,
          }),
        )
        yield* Effect.promise(() => transport.close())

        const settled = ui.commits.find((commit) => commit.tool === "question" && commit.phase === "final")
        expect(settled?.toolState).toBe("completed")
        expect(settled?.part?.state.status === "completed" ? settled.part.state.metadata.answers : undefined).toEqual([
          ["fast"],
        ])
        expect(ui.commits.some((commit) => commit.kind === "assistant" && commit.text.includes("picked fast"))).toBe(
          true,
        )
        expect(ui.events.findLast((event) => event.type === "stream.view")).toEqual({
          type: "stream.view",
          view: { type: "prompt" },
        })
        expect(requested.filter((path) => legacyRoute.test(path))).toEqual([])
      }).pipe(Effect.provide(TestLLMServer.layer)),
    30_000,
  )

  it.live(
    "ends a turn interrupted through the V2 interrupt route without an error row",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: false, config: testProviderConfig(llm.url) })
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() =>
          sdk.v2.session.create({ location: { directory } }, { throwOnError: true }).then((result) => result.data.data),
        )
        yield* llm.hang

        const ui = footer()
        const transport = yield* Effect.promise(() =>
          createSessionTransport({
            sdk,
            directory,
            sessionID: created.id,
            thinking: true,
            limits: () => ({}),
            footer: ui.api,
          }),
        )
        const running = transport.runPromptTurn({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          variant: undefined,
          prompt: { text: "take your time", parts: [] },
          files: [],
          includeFiles: false,
        })
        yield* llm.wait(1)
        yield* Effect.promise(() => sdk.v2.session.interrupt({ sessionID: created.id }, { throwOnError: true }))
        yield* Effect.promise(() => running)
        yield* Effect.promise(() => transport.close())

        expect(ui.commits.filter((commit) => commit.kind === "error")).toEqual([])
        const messages = yield* Effect.promise(() => loadTranscript(sdk, created.id))
        const replayed = replaySession({
          sessionID: created.id,
          entries: transcriptEntries({ sessionID: created.id, directory, messages }),
          permissions: [],
          questions: [],
          thinking: true,
          limits: {},
        })
        expect(replayed.commits.filter((commit) => commit.kind === "error")).toEqual([])
        const status = yield* Effect.promise(() =>
          sdk.v2.session.status({ sessionID: created.id }, { throwOnError: true }).then((result) => result.data.data),
        )
        expect(status).toEqual({ type: "idle" })
        expect(requested.filter((path) => legacyRoute.test(path))).toEqual([])
      }).pipe(Effect.provide(TestLLMServer.layer)),
    30_000,
  )
})
