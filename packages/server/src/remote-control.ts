export * as RemoteControl from "./remote-control"

import { Context, Layer } from "effect"
import type { LoginStep, RemoteStatus } from "@miao/protocol/groups/remote"

/**
 * What the `/api/remote*` routes drive. Only `miao remote` provides it (backed
 * by its connector host); on every other server the service is absent and the
 * routes answer 404, so control never reaches a process that runs no channels.
 */
export interface Interface {
  readonly status: () => Promise<RemoteStatus>
  /** Undefined when no connector has that id. */
  readonly login: (connector: string) => Promise<{ readonly flow: string } | undefined>
  /** Past and future steps of a flow; undefined for an unknown flow. */
  readonly events: (flow: string) => AsyncIterable<LoginStep> | undefined
  readonly input: (flow: string, value: string | Readonly<Record<string, string>>) => "accepted" | "unknown" | "idle"
  readonly cancel: (flow: string) => boolean
  readonly remove: (connector: string, account: string) => Promise<boolean>
  /** A pair step, an error message when the connector names owners at login, or undefined for an unknown account. */
  readonly pair: (connector: string, account: string) => Promise<LoginStep | { readonly error: string } | undefined>
  readonly test: (
    connector: string,
    account: string,
  ) => Promise<{ readonly ok: boolean; readonly sent: number; readonly error?: string } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/server/RemoteControl") {}

export const layer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
