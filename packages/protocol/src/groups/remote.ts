// Control routes of the `miao remote` daemon: connector and account status,
// login flows rendered as steps, pairing, test messages, and logout. Only a
// server started by `miao remote` serves them; every other server answers 404.
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "../errors"

export class RemoteNotFoundError extends Schema.TaggedErrorClass<RemoteNotFoundError>()(
  "RemoteNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const LoginField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  secret: Schema.optional(Schema.Boolean),
  optional: Schema.optional(Schema.Boolean),
  placeholder: Schema.optional(Schema.String),
}).annotate({ identifier: "RemoteLoginField" })

const AccountInfo = Schema.Struct({ id: Schema.String, label: Schema.String }).annotate({
  identifier: "RemoteAccountInfo",
})

export const LoginStep = Schema.Union([
  Schema.Struct({ type: Schema.Literal("qr"), content: Schema.String, hint: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("code"), prompt: Schema.String }),
  Schema.Struct({ type: Schema.Literal("form"), title: Schema.String, fields: Schema.Array(LoginField) }),
  Schema.Struct({ type: Schema.Literal("open"), url: Schema.String, hint: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("progress"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("pair"),
    code: Schema.String,
    expiresAt: Schema.Number,
    link: Schema.optional(Schema.String),
    hint: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    connector: Schema.String,
    account: AccountInfo,
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]).annotate({ identifier: "RemoteLoginStep" })
export type LoginStep = typeof LoginStep.Type

export const AccountStatus = Schema.Struct({
  connector: Schema.String,
  account: Schema.String,
  label: Schema.String,
  state: Schema.Literals(["connected", "connecting", "retrying", "needs-login", "unpaired", "offline", "error"]),
  detail: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  pairing: Schema.optional(Schema.Struct({ expiresAt: Schema.Number })),
  error: Schema.optional(Schema.String),
  lastActivityAt: Schema.optional(Schema.Number),
  pid: Schema.optional(Schema.Number),
  pushesToday: Schema.Number,
  pushBudget: Schema.optional(Schema.Number),
  pending: Schema.Number,
  approvals: Schema.Number,
}).annotate({ identifier: "RemoteAccountStatus" })
export type AccountStatus = typeof AccountStatus.Type

export const ConnectorStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.Literals(["poll", "socket", "webhook"])),
  pairing: Schema.Boolean,
  notice: Schema.optional(Schema.String),
  accounts: Schema.Array(AccountStatus),
}).annotate({ identifier: "RemoteConnectorStatus" })
export type ConnectorStatus = typeof ConnectorStatus.Type

export const RemoteStatus = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  version: Schema.String,
  startedAt: Schema.Number,
  connectors: Schema.Array(ConnectorStatus),
}).annotate({ identifier: "RemoteStatus" })
export type RemoteStatus = typeof RemoteStatus.Type

export const LoginInput = Schema.Struct({
  value: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
}).annotate({ identifier: "RemoteLoginAnswer" })

export const SendResult = Schema.Struct({
  ok: Schema.Boolean,
  sent: Schema.Number,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "RemoteSendResult" })

const account = { connector: Schema.String, account: Schema.String }

export const RemoteGroup = HttpApiGroup.make("server.remote")
  .add(
    HttpApiEndpoint.get("remote.get", "/api/remote", {
      success: RemoteStatus,
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.get",
        summary: "Get remote daemon status",
        description:
          "Status of the `miao remote` daemon: connectors, accounts, push usage, and held results. Other servers answer 404.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("remote.login.start", "/api/remote/login/:connector", {
      params: { connector: Schema.String },
      success: Schema.Struct({ flow: Schema.String }),
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.login.start",
        summary: "Start a connector login",
        description: "Start logging in to an IM connector. Follow the returned flow with the event route.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("remote.login.events", "/api/remote/login/:flow/event", {
      params: { flow: Schema.String },
      success: HttpApiSchema.StreamSse({ data: LoginStep }),
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.login.events",
        summary: "Follow a connector login",
        description:
          "Server-sent login steps (QR code, input requests, pairing code, done, error); ends with the flow.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("remote.login.input", "/api/remote/login/:flow/input", {
      params: { flow: Schema.String },
      payload: LoginInput,
      success: HttpApiSchema.NoContent,
      error: [RemoteNotFoundError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.login.input",
        summary: "Answer a login step",
        description: "Answer the pending code (string) or form (record) step of a login flow.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("remote.login.cancel", "/api/remote/login/:flow", {
      params: { flow: Schema.String },
      success: HttpApiSchema.NoContent,
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.login.cancel",
        summary: "Cancel a connector login",
        description: "Cancel a login flow that has not finished.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("remote.account.remove", "/api/remote/account/:connector/:account", {
      params: account,
      success: HttpApiSchema.NoContent,
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.account.remove",
        summary: "Disconnect an IM account",
        description: "Stop an account's channel and delete its credentials.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("remote.account.pair", "/api/remote/account/:connector/:account/pair", {
      params: account,
      success: LoginStep,
      error: [RemoteNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.account.pair",
        summary: "Issue a new pairing code",
        description:
          "Issue a one-time pairing code; the first person to send it to the bot becomes its owner. Only for connectors whose login cannot name an owner.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("remote.account.test", "/api/remote/account/:connector/:account/test", {
      params: account,
      success: SendResult,
      error: RemoteNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.remote.account.test",
        summary: "Send a test message",
        description: "Send a short test message to the account's owner.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "remote", description: "`miao remote` daemon control routes." }))
