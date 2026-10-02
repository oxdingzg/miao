import type { OpenCode, OpenCodeEvent } from "@miao/client"

export type Client = ReturnType<typeof OpenCode.make>

export type Event = OpenCodeEvent
export type EventOf<T extends Event["type"]> = Extract<Event, { type: T }>

export type Session = Awaited<ReturnType<Client["sessions"]["get"]>>
export type Message = Awaited<ReturnType<Client["messages"]["list"]>>["data"][number]
export type MessageOf<T extends Message["type"]> = Extract<Message, { type: T }>
export type AssistantContent = MessageOf<"assistant">["content"][number]
export type ToolContent = Extract<AssistantContent, { type: "tool" }>
export type ToolState = ToolContent["state"]
export type ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }
export type Todo = Awaited<ReturnType<Client["sessions"]["todo"]>>[number]
