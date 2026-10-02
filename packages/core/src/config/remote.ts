export * as ConfigRemote from "./remote"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class WeChat extends Schema.Class<WeChat>("ConfigV2.Remote.WeChat")({
  push_budget_per_day: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "Proactive WeChat messages (approval asks and turn-end notices) allowed per day (default: 4). iLink throttles bots after about 5-6; replies to your own messages do not count.",
  }),
}) {}

export class QQ extends Schema.Class<QQ>("ConfigV2.Remote.QQ")({
  api: Schema.String.pipe(Schema.optional).annotate({
    description:
      "QQ bot OpenAPI base URL (default: https://api.bot.qq.com). When unset, miao falls back to the older bots.qq.com / api.sgroup.qq.com hosts if the new one fails; a configured URL is used as is.",
  }),
  portal: Schema.String.pipe(Schema.optional).annotate({
    description: "QQ Open Platform host for QR binding (default: https://q.qq.com).",
  }),
  markdown: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Send replies as QQ markdown (default: true). miao falls back to plain text when the bot lacks markdown permission.",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Remote")({
  port: PositiveInt.pipe(Schema.optional).annotate({
    description: "Port for the server `miao remote` runs on 127.0.0.1 (default: 4097). `miao attach` connects here.",
  }),
  projects: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
    description:
      "Project alias → directory. IM users can only list, create, and drive sessions inside these directories; ~ expands to the home directory.",
  }),
  wechat: WeChat.pipe(Schema.optional).annotate({ description: "WeChat (iLink) channel settings" }),
  qq: QQ.pipe(Schema.optional).annotate({ description: "QQ bot channel settings" }),
  connectors: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      "Third-party IM connectors to load: npm package names (installed and cached like plugins) or local module paths. Each must export a connector made with defineConnector from @miao/remote.",
  }),
  settings: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).pipe(Schema.optional).annotate({
    description: "Settings for third-party connectors, keyed by connector id.",
  }),
}) {}
