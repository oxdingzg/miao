export * as ConfigRemote from "./remote"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class WeChat extends Schema.Class<WeChat>("ConfigV2.Remote.WeChat")({
  push_budget_per_day: NonNegativeInt.pipe(Schema.optional).annotate({
    description:
      "Proactive WeChat messages (approval asks and turn-end notices) allowed per day (default: 4). iLink throttles bots after about 5-6; replies to your own messages do not count.",
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
}) {}
