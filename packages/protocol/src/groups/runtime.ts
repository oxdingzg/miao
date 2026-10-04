import { RuntimeIdentity } from "@miao/schema/runtime-identity"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"

export const RuntimeGroup = HttpApiGroup.make("server.runtime").add(
  HttpApiEndpoint.get("runtime.identity", "/api/runtime/identity", {
    query: { challenge: RuntimeIdentity.Challenge },
    success: RuntimeIdentity.Proof,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.identity",
      summary: "Verify local Runtime identity",
      description:
        "Challenge response proving possession of the local discovery credential before a client sends authentication. Does not authorize application access.",
    }),
  ),
)
