import { RuntimeIdentity } from "@miao/schema/runtime-identity"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
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
  HttpApiEndpoint.post("runtime.stop", "/api/runtime/stop", {
    success: HttpApiSchema.NoContent,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.stop",
      summary: "Stop the local Runtime",
      description:
        "Requires the local Runtime administrator credential. Requests graceful shutdown; remote device grants do not expose this operation.",
    }),
  ),
)
