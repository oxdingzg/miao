import { RuntimeIdentity } from "@miao/schema/runtime-identity"
import { RemoteAccess } from "@miao/schema/remote-access"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"

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
  HttpApiEndpoint.get("runtime.control.get", "/api/runtime/control", {
    success: RemoteAccess.Status,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.runtime.control.get", summary: "Inspect local Remote Control status" }),
  ),
  HttpApiEndpoint.post("runtime.control.configure", "/api/runtime/control/configuration", {
    payload: RemoteAccess.Configuration,
    success: RemoteAccess.Status,
    error: [ServiceUnavailableError, InvalidRequestError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.control.configure",
      summary: "Configure the local owner's outbound relay",
      description:
        "Requires the local Runtime administrator credential. Persists an owner-only relay credential and reconnects transport without restarting sessions. Not exposed to remote device grants.",
    }),
  ),
  HttpApiEndpoint.post("runtime.control.invite", "/api/runtime/control/invitation", {
    payload: RemoteAccess.Policy,
    success: RemoteAccess.Invitation,
    error: [ServiceUnavailableError, InvalidRequestError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.control.invite",
      summary: "Create a local owner-approved pairing invitation",
    }),
  ),
  HttpApiEndpoint.get("runtime.control.pending", "/api/runtime/control/pairing", {
    success: Schema.Array(RemoteAccess.Candidate),
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.runtime.control.pending", summary: "List devices awaiting local approval" }),
  ),
  HttpApiEndpoint.post("runtime.control.approve", "/api/runtime/control/pairing/:pairingID/approve", {
    params: { pairingID: Schema.String },
    payload: Schema.Struct({ publicKey: Schema.String }),
    success: RemoteAccess.Grant,
    error: [ServiceUnavailableError, ConflictError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.control.approve",
      summary: "Confirm the exact device key for a pending invitation",
    }),
  ),
  HttpApiEndpoint.delete("runtime.control.reject", "/api/runtime/control/pairing/:pairingID", {
    params: { pairingID: Schema.String },
    success: HttpApiSchema.NoContent,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.runtime.control.reject", summary: "Reject a pending pairing invitation" }),
  ),
  HttpApiEndpoint.get("runtime.control.devices", "/api/runtime/control/device", {
    success: Schema.Array(RemoteAccess.Grant),
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.runtime.control.devices", summary: "List locally authorized device grants" }),
  ),
  HttpApiEndpoint.post("runtime.control.revoke", "/api/runtime/control/device/:grantID/revoke", {
    params: { grantID: Schema.String },
    payload: Schema.Struct({ version: Schema.Int }),
    success: RemoteAccess.Grant,
    error: [ServiceUnavailableError, ConflictError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.runtime.control.revoke",
      summary: "Revoke a device grant at its observed version",
    }),
  ),
)
