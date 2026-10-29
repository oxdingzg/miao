import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { handoffNativeDirectoryPermissions } from "@/engine/native-directory-permission-handoff"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Patterns = Schema.Struct({ patterns: Schema.Array(Schema.Struct({ id: Schema.String })) })
const failure = (request: Promise<unknown>) =>
  request.then(
    () => undefined,
    (error: unknown) => error,
  )
const openSource = (db: string, directory: string, project = "project") =>
  EngineClient.startPermissionSource({ binary: binary!, db, project, directory })
const openDestination = (db: string, directory: string, project = "project") =>
  EngineClient.startPermissionStore({ binary: binary!, db, project, context: { directory } })
const migrate = (source: Pick<EngineClient, "request">, destination: Pick<EngineClient, "request">) =>
  handoffNativeDirectoryPermissions({
    projectID: "project",
    source,
    destination,
    capabilities: capabilities(binary!) ?? {},
  })

async function seed(db: string, directory: string) {
  await Bun.write(path.join(directory, "fixture"), "fixture")
  const client = EngineClient.start({
    binary: binary!,
    db,
    workspace: directory,
    model: "fixture",
    provider: "anthropic",
    endpoint: "http://127.0.0.1:9",
    env: { ANTHROPIC_API_KEY: "fixture-only" },
  })
  try {
    await client.request("permission_pattern_put", { rule: { action: "read", resource: "a/**", effect: "allow" } })
    await client.request("permission_pattern_put", { rule: { action: "read", resource: "b/**", effect: "allow" } })
  } finally {
    await client.close()
  }
}

test.skipIf(!binary)(
  "directory host driver freezes and imports through real controls, then preserves revocations on reopen",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "engine.db")
    const root = path.join(tmp.path, "permissions.db")
    await seed(db, tmp.path)
    const source = openSource(db, tmp.path)
    const destination = openDestination(root, tmp.path)
    try {
      const imported = await migrate(source, destination)
      expect(imported.patterns).toHaveLength(2)
      expect(imported.migration?.imported).toBe(2)
      await destination.request("context_remove", { id: imported.patterns[0]!.id })
    } finally {
      await Promise.all([source.close(), destination.close()])
    }
    const reopened = openSource(db, tmp.path)
    const target = openDestination(root, tmp.path)
    try {
      expect((await migrate(reopened, target)).patterns).toHaveLength(1)
      expect(await reopened.request("snapshot")).toMatchObject({ state: "completed", patterns: expect.any(Array) })
    } finally {
      await Promise.all([reopened.close(), target.close()])
    }
  },
  30_000,
)

for (const lost of ["context_handoff", "complete"]) {
  test.skipIf(!binary)(
    `directory host driver recovers a lost ${lost} acknowledgement without restoring a revoked rule`,
    async () => {
      await using tmp = await tmpdir()
      const db = path.join(tmp.path, "engine.db")
      await seed(db, tmp.path)
      const source = openSource(db, tmp.path)
      const destination = openDestination(path.join(tmp.path, "permissions.db"), tmp.path)
      const lose = (client: EngineClient) => ({
        request: async (method: string, params?: unknown) => {
          const result = await client.request(method, params)
          if (method === lost) throw new Error("injected lost acknowledgement")
          return result
        },
      })
      try {
        expect(await failure(migrate(lose(source), lose(destination)))).toBeInstanceOf(Error)
        const committed = Schema.decodeUnknownSync(Patterns)(await destination.request("context_snapshot"))
        expect(committed.patterns).toHaveLength(2)
        await destination.request("context_remove", { id: committed.patterns[0]!.id })
        expect((await migrate(source, destination)).patterns).toHaveLength(1)
      } finally {
        await Promise.all([source.close(), destination.close()])
      }
    },
    30_000,
  )
}

test.skipIf(!binary)(
  "completed directory handoff refuses a lost destination receipt without restoring revoked rules",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "engine.db")
    const root = path.join(tmp.path, "permissions.db")
    await seed(db, tmp.path)
    const source = openSource(db, tmp.path)
    const destination = openDestination(root, tmp.path)
    try {
      const imported = await migrate(source, destination)
      await destination.request("context_remove", { id: imported.patterns[0]!.id })
      const database = new Database(root)
      try {
        database.run("DELETE FROM permission_directory_migration")
      } finally {
        database.close()
      }
      expect(await failure(migrate(source, destination))).toBeInstanceOf(Error)
      expect(Schema.decodeUnknownSync(Patterns)(await destination.request("context_snapshot")).patterns).toHaveLength(1)
    } finally {
      await Promise.all([source.close(), destination.close()])
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "directory host driver rejects a replaced destination and refuses importing into a receipt without its source",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "engine.db")
    const second = path.join(tmp.path, "second.db")
    await seed(db, tmp.path)
    await seed(second, tmp.path)
    const source = openSource(db, tmp.path)
    const unprepared = openSource(second, tmp.path)
    const destination = openDestination(path.join(tmp.path, "permissions.db"), tmp.path)
    const replacement = openDestination(path.join(tmp.path, "replacement.db"), tmp.path)
    try {
      await migrate(source, destination)
      expect(await failure(migrate(source, replacement))).toBeInstanceOf(Error)
      expect(await failure(migrate(unprepared, destination))).toBeInstanceOf(Error)
      expect(await unprepared.request("snapshot")).toBeNull()
      expect((await migrate(source, destination)).patterns).toHaveLength(2)
    } finally {
      await Promise.all([source.close(), unprepared.close(), destination.close(), replacement.close()])
    }
  },
  30_000,
)

test.skipIf(!binary)(
  "directory host driver refuses capability, project and directory mismatches before freezing",
  async () => {
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "engine.db")
    const other = path.join(tmp.path, "other")
    await seed(db, tmp.path)
    await Bun.write(path.join(other, "fixture"), "fixture")
    const source = openSource(db, tmp.path)
    const destination = openDestination(path.join(tmp.path, "permissions.db"), tmp.path)
    const foreignProject = openDestination(path.join(tmp.path, "foreign.db"), tmp.path, "foreign")
    const foreignDirectory = openDestination(path.join(tmp.path, "other.db"), other)
    try {
      expect(
        await failure(
          handoffNativeDirectoryPermissions({ projectID: "project", source, destination, capabilities: {} }),
        ),
      ).toBeInstanceOf(Error)
      expect(await source.request("snapshot")).toBeNull()
      expect(await failure(migrate(source, foreignProject))).toBeInstanceOf(Error)
      expect(await failure(migrate(source, foreignDirectory))).toBeInstanceOf(Error)
      expect(await source.request("snapshot")).toBeNull()
      expect((await migrate(source, destination)).patterns).toHaveLength(2)
    } finally {
      await Promise.all([source.close(), destination.close(), foreignProject.close(), foreignDirectory.close()])
    }
  },
  30_000,
)
