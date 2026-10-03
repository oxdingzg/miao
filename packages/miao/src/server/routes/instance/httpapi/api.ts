import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EventV2 } from "@miao/core/event"
import { EventManifest } from "@/event-manifest"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { SkillV2 } from "@miao/core/skill"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { makeApi } from "@miao/protocol/api"
import { LocationMiddleware } from "@miao/server/location"
import { SessionLocationMiddleware } from "@miao/server/middleware/session-location"
import { ClientSchemas } from "./public-schemas"

const EventSchema = Schema.Union([
  ...EventManifest.Latest.values()
    .map((definition) =>
      Schema.Struct({
        id: EventV2.ID,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    )
    .toArray(),
  InstanceDisposed,
]).annotate({ identifier: "Event" })

export const ServerApi = makeApi({
  definitions: EventManifest.Latest.values().toArray(),
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const OpenCodeHttpApi = HttpApi.make("miao")
  .addHttpApi(ServerApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Question.Replied,
    Question.Rejected,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
    SkillV2.Source,
    ...ClientSchemas,
  ])
