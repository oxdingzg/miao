export * as SessionCommandPrepare from "./command-prepare"

import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Option } from "effect"
import { ToolFailure } from "@miao/llm"
import { AgentV2 } from "../agent"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { BashTool } from "../tool/bash"
import { SessionCommand } from "./command"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { FileAttachment, AgentAttachment, Prompt } from "./prompt"
import { SessionSchema } from "./schema"

export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_SHELLS = 32

export const prepare = Effect.fn("SessionCommand.prepare")(function* (
  user: SessionMessage.User,
  session: SessionSchema.Info,
  services: {
    readonly agents: AgentV2.Interface
    readonly fs: FSUtil.Interface
    readonly mutation: LocationMutation.Interface
    readonly permission: PermissionV2.Interface
    readonly shell: BashTool.ExecutionInterface
    readonly events: EventV2.Interface
  },
) {
  if (!user.command) return Prompt.make({ text: user.text, files: user.files, agents: user.agents })
  const selected = yield* services.agents.select(user.command.agent ?? session.agent)
  if (user.command.agent && !selected.info)
    return yield* new ToolFailure({ message: `Command agent is unavailable: ${user.command.agent}` })
  const agent = selected.id
  const matches = SessionCommand.shell(user.text)
  if (matches.length > MAX_SHELLS)
    return yield* new ToolFailure({ message: "Command has too many shell substitutions." })
  const outputs = yield* Effect.forEach(matches, (match, index) =>
    Effect.gen(function* () {
      const callID = `${user.id}/shell/${index}`
      yield* services.events.publish(
        SessionEvent.Shell.Started,
        {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          callID,
          command: match[1],
        },
        { metadata: { commandInvocation: user.id } },
      )
      const result = yield* services.shell
        .execute(
          { command: match[1] },
          {
            sessionID: session.id,
            agent,
            callID,
            source: { type: "command", messageID: user.id, name: user.command?.name ?? "", callID },
          },
        )
        .pipe(
          Effect.tapError((error) =>
            services.events.publish(SessionEvent.Shell.Ended, {
              sessionID: session.id,
              timestamp: DateTime.makeUnsafe(Date.now()),
              callID,
              output: error.message,
            }),
          ),
          Effect.onInterrupt(() =>
            services.events.publish(SessionEvent.Shell.Ended, {
              sessionID: session.id,
              timestamp: DateTime.makeUnsafe(Date.now()),
              callID,
              output: "Command preparation interrupted.",
            }),
          ),
        )
      yield* services.events.publish(SessionEvent.Shell.Ended, {
        sessionID: session.id,
        timestamp: yield* DateTime.now,
        callID,
        output: result.output,
      })
      if (result.timeout) return yield* new ToolFailure({ message: "Command shell substitution timed out." })
      if (result.truncated)
        return yield* new ToolFailure({ message: "Command shell substitution output exceeded its capture limit." })
      return result.output
    }),
  )
  const expanded = matches.reduce(
    (state, match, index) => ({
      text: state.text + user.text.slice(state.offset, match.index) + outputs[index],
      offset: (match.index ?? 0) + match[0].length,
    }),
    { text: "", offset: 0 },
  )
  const text = (expanded.text + user.text.slice(expanded.offset)).trim()
  let totalBytes = Buffer.byteLength(text, "utf8")
  if (totalBytes > 4 * MAX_FILE_BYTES)
    return yield* new ToolFailure({ message: "Expanded command text exceeded its input limit." })
  const mentions = SessionCommand.files(text)
  if (mentions.length > 32) return yield* new ToolFailure({ message: "Command has too many file/agent references." })
  const files: FileAttachment[] = [...(user.files ?? [])]
  const agents: AgentAttachment[] = [...(user.agents ?? [])]
  const seen = new Set<string>()
  for (const match of mentions) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (yield* services.agents.get(AgentV2.ID.make(name))) {
      agents.push(AgentAttachment.make({ name }))
      continue
    }
    const target = yield* services.mutation.resolve({
      path: name.startsWith("~/") ? path.join(os.homedir(), name.slice(2)) : name,
      kind: "directory",
    })
    const source: PermissionV2.Source = {
      type: "command",
      messageID: user.id,
      name: user.command.name,
      callID: `${user.id}/file/${files.length}`,
    }
    if (target.externalDirectory)
      yield* services.permission.assert({
        ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
        sessionID: session.id,
        agent,
        source,
      })
    yield* services.permission.assert({
      action: "read",
      resources: [target.resource],
      save: ["*"],
      sessionID: session.id,
      agent,
      source,
    })
    const info = yield* services.fs.stat(target.canonical)
    if (info.type === "Directory") {
      const entries = yield* services.fs.readDirectory(target.canonical)
      const listing = entries.slice(0, 200).join("\n") + (entries.length > 200 ? "\n[listing truncated]" : "")
      totalBytes += Buffer.byteLength(listing, "utf8")
      if (totalBytes > 4 * MAX_FILE_BYTES) return yield* new ToolFailure({ message: "Command references exceeded their combined input limit." })
      files.push(
        FileAttachment.make({
          uri: `data:text/plain;base64,${Buffer.from(listing).toString("base64")}`,
          mime: "text/plain",
          name,
          path: target.canonical,
        }),
      )
      continue
    }
    if (info.size > MAX_FILE_BYTES)
      return yield* new ToolFailure({
        message: `Command file exceeds ${MAX_FILE_BYTES} bytes: ${name}. Read it in pages instead.`,
      })
    if (info.type !== "File")
      return yield* new ToolFailure({ message: `Command reference is not a regular file: ${name}` })
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* services.fs.open(target.canonical, { flag: "r" })
        const chunks: Uint8Array[] = []
        let size = 0
        while (size <= MAX_FILE_BYTES) {
          const chunk = yield* file.readAlloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size))
          if (Option.isNone(chunk)) break
          size += chunk.value.byteLength
          if (size > MAX_FILE_BYTES)
            return yield* new ToolFailure({ message: `Command file grew beyond its size limit: ${name}` })
          chunks.push(chunk.value)
        }
        return Buffer.concat(chunks)
      }),
    )
    totalBytes += bytes.byteLength
    if (totalBytes > 4 * MAX_FILE_BYTES)
      return yield* new ToolFailure({ message: "Command references exceeded their combined input limit." })
    const mime = FSUtil.mimeType(target.canonical)
    files.push(
      FileAttachment.make({
        uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
        mime,
        name,
        path: target.canonical,
      }),
    )
  }
  return Prompt.make({ text, files: files.length ? files : undefined, agents: agents.length ? agents : undefined })
})
