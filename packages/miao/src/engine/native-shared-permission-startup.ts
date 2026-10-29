import { realpath } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import type { Database } from "@miao/core/database/database"
import type { ProjectV2 } from "@miao/core/project"
import { EngineClient } from "./client"
import { resolveEngine } from "./discovery"
import { handoffNativeDirectoryPermissions } from "./native-directory-permission-handoff"
import { handoffNativeProjectPermissions } from "./native-project-permission-handoff"
import { NativePermissionContext } from "./native-permission-context"

/** Complete both real controls before a managed child can claim execution. */
export async function prepareSharedPermissionOwner(input: {
  binary: string
  source: string
  root: string
  directory: string
  projectID: ProjectV2.ID
  db: Database.Interface["db"]
}) {
  const found = resolveEngine({ environment: { MIAO_ENGINE_BIN: input.binary }, requireSharedPermissions: true })
  const supported = found?.capabilities
  if (
    supported?.permissionSourceInitialize !== 1 ||
    supported.permissionProjectStore !== 1 ||
    supported.permissionProjectHandoff !== 1 ||
    supported.permissionContextStore !== 1 ||
    supported.permissionContextHandoff !== 1 ||
    supported.permissionSourceHandoff !== 1 ||
    supported.permissionChangefeed !== 1
  )
    throw new Error("paired shared permission startup capabilities required before freezing either source")
  const destination = EngineClient.startPermissionStore({
    binary: input.binary,
    db: input.root,
    project: input.projectID,
    context: { directory: input.directory },
  })
  try {
    const before = Schema.decodeUnknownSync(NativePermissionContext.Snapshot)(
      await destination.request("context_snapshot"),
    )
    const root = await realpath(input.root)
    const directory = await realpath(input.directory)
    const relative = path.relative(directory, root)
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
      throw new Error("shared permission Root must be outside the workspace before migration")
    if (before.project.project !== input.projectID) throw new Error("shared permission startup project mismatch")
    const source = EngineClient.startPermissionSource({
      binary: input.binary,
      db: input.source,
      project: input.projectID,
      directory: input.directory,
      initialize: true,
    })
    try {
      // A live old native owner blocks Source preparation before Core is frozen.
      // Failure after this boundary deliberately keeps Source frozen for retry.
      await handoffNativeDirectoryPermissions({
        projectID: input.projectID,
        source,
        destination,
        capabilities: supported,
      })
      await handoffNativeProjectPermissions({
        db: input.db,
        projectID: input.projectID,
        client: destination,
        capabilities: supported,
      })
      const after = Schema.decodeUnknownSync(NativePermissionContext.Snapshot)(
        await destination.request("context_snapshot"),
      )
      if (after.project.authority !== before.project.authority || !after.project.migration || !after.migration)
        throw new Error("paired shared permission startup lost its completed binding")
      return {
        options: { savedRules: undefined, sharedPermission: { db: root, project: input.projectID } },
        snapshot: after,
      }
    } finally {
      await source.close()
    }
  } finally {
    await destination.close()
  }
}
