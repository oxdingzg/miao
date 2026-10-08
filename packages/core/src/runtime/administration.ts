export * as RuntimeAdministration from "./administration"

import type { RemoteAccess } from "@miao/schema/remote-access"

/** Implemented only by the storage-owning Runtime, never by a remote grant. */
export interface Interface {
  readonly setEnabled?: (enabled: boolean) => Promise<RemoteAccess.Status>
  readonly setSessionEnabled?: (sessionID: string, enabled: boolean) => Promise<RemoteAccess.Status>
  readonly status: () => RemoteAccess.Status
  readonly configure?: (configuration: RemoteAccess.Configuration) => Promise<RemoteAccess.Status>
  readonly invite: (policy: RemoteAccess.Policy) => Promise<RemoteAccess.Invitation>
  readonly pending: () => ReadonlyArray<RemoteAccess.Candidate>
  readonly approve: (pairingID: string, publicKey: string) => Promise<RemoteAccess.Grant>
  readonly reject: (pairingID: string) => void
  readonly devices: () => ReadonlyArray<RemoteAccess.Grant>
  readonly revoke: (grantID: string, version: number) => Promise<RemoteAccess.Grant>
}
