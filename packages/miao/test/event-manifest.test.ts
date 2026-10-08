import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@miao/core/session/event"
import { EventManifest as SchemaEventManifest } from "@miao/schema/event-manifest"
import { SessionTodo } from "@miao/core/session/todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(101)
    expect(EventManifest.Latest.get("session.next.prompt.cancelled")).toBe(SessionEvent.PromptCancelled)
    expect(EventManifest.Durable.get("session.next.prompt.cancelled.1")).toBe(SessionEvent.PromptCancelled)
    expect(EventManifest.Latest.get("session.next.delegation.started")).toBe(SessionEvent.DelegationStarted)
    expect(EventManifest.Latest.get("session.next.delegation.ended")).toBe(SessionEvent.DelegationEnded)
    expect(EventManifest.Latest.get("session.next.delegation.reported")).toBe(SessionEvent.DelegationReported)
    expect(EventManifest.Durable.get("session.next.delegation.started.1")).toBe(SessionEvent.DelegationStarted)
    expect(EventManifest.Durable.get("session.next.delegation.ended.1")).toBe(SessionEvent.DelegationEnded)
    expect(EventManifest.Durable.get("session.next.delegation.reported.1")).toBe(SessionEvent.DelegationReported)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("session.next.command.started")).toBe(SessionEvent.Command.Started)
    expect(EventManifest.Latest.get("session.next.command.completed")).toBe(SessionEvent.Command.Completed)
    expect(EventManifest.Latest.get("session.next.command.failed")).toBe(SessionEvent.Command.Failed)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
