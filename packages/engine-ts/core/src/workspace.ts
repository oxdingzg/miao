export * as WorkspaceV2 from "./workspace"

import { Context, Effect, Schema } from "effect"
import { Workspace } from "@miao/schema/workspace"
import { type AbsolutePath } from "./schema"
import { ProjectV2 } from "./project"

export const ID = Workspace.ID
export type ID = typeof ID.Type

export type Info = Workspace.Info
export type AdapterEntry = Workspace.AdapterEntry
export type ConnectionStatus = Workspace.ConnectionStatus
export type CreateInput = Workspace.CreateInput
export type WarpInput = Workspace.WarpInput

export interface Scope {
  readonly projectID: ProjectV2.ID
  readonly directory: AbsolutePath
}

export class UnsupportedError extends Schema.TaggedErrorClass<UnsupportedError>()("WorkspaceV2.UnsupportedError", {
  message: Schema.String,
}) {}

export type Error = UnsupportedError

export interface Interface {
  readonly list: (scope: Scope) => Effect.Effect<Info[]>
  readonly status: (scope: Scope) => Effect.Effect<ConnectionStatus[]>
  readonly adapters: (scope: Scope) => Effect.Effect<AdapterEntry[]>
  readonly create: (input: CreateInput, scope: Scope) => Effect.Effect<Info, Error>
  readonly remove: (id: ID, scope: Scope) => Effect.Effect<Info | undefined, Error>
  readonly syncList: (scope: Scope) => Effect.Effect<void, Error>
  readonly warp: (input: WarpInput, scope: Scope) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@miao/WorkspaceV2") {}
