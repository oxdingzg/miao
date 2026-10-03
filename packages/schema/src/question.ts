export * as Question from "./question"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionV2.ID"),
  statics((schema) => {
    const create = () => schema.make("que_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Option = Schema.Struct({
  label: Schema.String.annotate({ description: "Display text (1-5 words, concise)" }),
  description: Schema.String.annotate({ description: "Explanation of choice" }),
  preview: Schema.String.pipe(optional).annotate({
    description:
      "Optional preview shown when this option is focused; rendered as markdown in a monospace box. Only for single-select questions.",
  }),
}).annotate({ identifier: "QuestionV2.Option" })
export interface Option extends Schema.Schema.Type<typeof Option> {}

const base = {
  question: Schema.String.annotate({ description: "Complete question" }),
  header: Schema.String.check(Schema.isMaxLength(12)).annotate({
    description: "Very short label (max 12 chars)",
  }),
  // Same hard bounds as Claude Code's AskUserQuestion: a choice needs a real
  // decision, so fewer than two options is refused rather than padded.
  options: Schema.Array(Option)
    .check(Schema.isMinLength(2), Schema.isMaxLength(4))
    .annotate({ description: "Available choices (2-4)" }),
  multiSelect: Schema.Boolean.pipe(optional).annotate({ description: "Allow selecting multiple choices" }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.Boolean.pipe(optional).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionV2.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionV2.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Tool = Schema.Struct({
  messageID: Schema.String,
  callID: Schema.String,
}).annotate({ identifier: "QuestionV2.Tool" })
export interface Tool extends Schema.Schema.Type<typeof Tool> {}

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Schema.Array(Info)
    .check(Schema.isMinLength(1), Schema.isMaxLength(4))
    .annotate({ description: "Questions to ask (1-4)" }),
  tool: Tool.pipe(optional),
}).annotate({ identifier: "QuestionV2.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionV2.Answer" })
export type Answer = typeof Answer.Type

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionV2.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

const Asked = define({ type: "question.v2.asked", schema: Request.fields })
const Replied = define({
  type: "question.v2.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    answers: Schema.Array(Answer),
  },
})
const Rejected = define({
  type: "question.v2.rejected",
  schema: {
    sessionID: SessionID,
    requestID: ID,
  },
})
export const Event = { Asked, Replied, Rejected, Definitions: inventory(Asked, Replied, Rejected) }

// Compatibility names for the question view models.
export type QuestionInfo = Info
export type QuestionAnswer = Answer
