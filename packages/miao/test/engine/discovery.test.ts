import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { capabilities, resolveEngine } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const engine = (protocol: number) => ({
  name: "miao-engine" as const,
  version: "9.9.9",
  protocol,
  schema: 12,
})

test("a discovered engine is used only when its protocol is new enough", () => {
  const probe = () => engine(2)
  const exists = () => true
  expect(resolveEngine({ environment: {}, probe, exists })?.binary).toContain("miao-engine")
  expect(resolveEngine({ environment: {}, probe: () => engine(1), exists })).toBeUndefined()
  expect(resolveEngine({ environment: {}, probe: () => undefined, exists })).toBeUndefined()
  expect(resolveEngine({ environment: {}, probe, exists: () => false })).toBeUndefined()
})

test("an explicit binary that is too old is an error, not a fallback", () => {
  expect(() =>
    resolveEngine({ environment: { MIAO_ENGINE_BIN: "/old" }, probe: () => engine(1), exists: () => true }),
  ).toThrow("requires protocol 2")
  expect(() =>
    resolveEngine({ environment: { MIAO_ENGINE_BIN: "/missing" }, probe: () => engine(2), exists: () => false }),
  ).toThrow("cannot report capabilities")
})

test("the explicit binary wins over discovery", () => {
  const found = resolveEngine({
    environment: { MIAO_ENGINE_BIN: "/chosen" },
    probe: () => engine(2),
    exists: () => true,
  })
  expect(found?.binary).toBe("/chosen")
})

test.skipIf(process.platform === "win32")(
  "capabilities reads a real engine contract",
  async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "miao-engine")
    await Bun.write(
      script,
      '#!/bin/sh\nprintf \'%s\' \'{"name":"miao-engine","version":"9.9.9","protocol":2,"schema":12}\'\n',
    )
    await chmod(script, 0o755)
    expect(capabilities(script)).toEqual(engine(2))
    await Bun.write(script, "#!/bin/sh\nprintf '%s' 'not json'\n")
    expect(capabilities(script)).toBeUndefined()
  },
  10_000,
)

test.skipIf(process.platform === "win32")(
  "capabilities decodes the engine's snake_case route schema",
  async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "miao-engine")
    // The engine writes snake_case; a frame that only carries the camelCase
    // spelling used to make an older engine look like one that predates the
    // field, so the fail-fast never fired.
    const contract = (extra = "") =>
      `#!/bin/sh\nprintf '%s' '{"name":"miao-engine","version":"9.9.9","protocol":2,"schema":12${extra}}'\n`
    const probe = (environment: Record<string, string>) =>
      resolveEngine({ environment, probe: capabilities, exists: () => true })

    await Bun.write(script, contract(',"routes_schema":1'))
    await chmod(script, 0o755)
    expect(capabilities(script)).toEqual({ ...engine(2), routesSchema: 1 })
    expect(() => probe({ MIAO_ENGINE_BIN: script })).toThrow("route schema")

    await Bun.write(script, contract(',"routes_schema":2'))
    expect(probe({ MIAO_ENGINE_BIN: script })?.binary).toBe(script)

    // An engine that predates the field keeps the existing policy: accepted.
    await Bun.write(script, contract(',"build":"legacy"'))
    expect(capabilities(script)).toEqual(engine(2))

    // A frame that contradicts itself or carries a non-number is not a contract.
    await Bun.write(script, contract(',"routes_schema":2,"routesSchema":1'))
    expect(capabilities(script)).toBeUndefined()
    expect(() => probe({ MIAO_ENGINE_BIN: script })).toThrow("cannot report capabilities")

    await Bun.write(script, contract(',"routes_schema":"2"'))
    expect(capabilities(script)).toBeUndefined()
  },
  15_000,
)

test("an engine whose route manifest schema is too old is refused", () => {
  const older = { ...engine(2), routesSchema: 1 }
  expect(() =>
    resolveEngine({ environment: { MIAO_ENGINE_BIN: "/old" }, probe: () => older, exists: () => true }),
  ).toThrow("route schema")
  expect(resolveEngine({ environment: {}, probe: () => older, exists: () => true })).toBeUndefined()
  // Schema 2 is what this build's capacity-aware role routing needs.
  expect(
    resolveEngine({ environment: {}, probe: () => ({ ...engine(2), routesSchema: 2 }), exists: () => true })?.binary,
  ).toContain("miao-engine")
  // An engine that predates the field is still used; its loader decides.
  expect(resolveEngine({ environment: {}, probe: () => engine(2), exists: () => true })?.binary).toContain(
    "miao-engine",
  )
})

test("an installed preview's paired engine precedes the stable engine", () => {
  const executable = path.join("/preview", ".versions", "build", "miao")
  const paired = path.join(path.dirname(executable), process.platform === "win32" ? "miao-engine.exe" : "miao-engine")
  expect(resolveEngine({ executable, environment: {}, exists: () => true, probe: () => engine(2) })?.binary).toBe(
    paired,
  )
  expect(
    resolveEngine({
      executable,
      environment: { MIAO_ENGINE_BIN: "/chosen" },
      exists: () => true,
      probe: () => engine(2),
    })?.binary,
  ).toBe("/chosen")
})

test.skipIf(process.platform === "win32")("real engine route-schema fields are checked before selection", async () => {
  await using tmp = await tmpdir()
  const binary = path.join(tmp.path, "miao-engine")
  for (const input of [
    { wire: {}, normalized: undefined, accepted: true },
    { wire: { routes_schema: 1 }, normalized: 1, accepted: false },
    { wire: { routes_schema: 2 }, normalized: 2, accepted: true },
    { wire: { routes_schema: 2, catalog: 1 }, normalized: 2, accepted: true },
    {
      wire: {
        product_permission_requests: 1,
        product_permission_replies: 1,
        product_permission_cancel: 1,
        product_permission_diagnostics: 1,
        product_permission_auto: 1,
      },
      normalized: undefined,
      accepted: true,
    },
    { wire: { saved_permission_migration: 1 }, normalized: undefined, accepted: true },
    { wire: { permission_patterns: 1 }, normalized: undefined, accepted: true },
    { wire: { permission_pattern_changes: 1 }, normalized: undefined, accepted: true },
    { wire: { routesSchema: 2 }, normalized: 2, accepted: true },
    { wire: { routes_schema: 2, routesSchema: 2 }, normalized: 2, accepted: true },
  ]) {
    await Bun.write(binary, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ ...engine(2), ...input.wire })}'\n`)
    await chmod(binary, 0o755)
    expect(capabilities(binary)?.routesSchema).toBe(input.normalized)
    if ("catalog" in input.wire) expect(capabilities(binary)).toHaveProperty("catalog", 1)
    if ("permission_pattern_changes" in input.wire)
      expect(capabilities(binary)).toHaveProperty("permissionPatternChanges", 1)
    if ("saved_permission_migration" in input.wire)
      expect(capabilities(binary)).toHaveProperty("savedPermissionMigration", 1)
    if ("permission_patterns" in input.wire) expect(capabilities(binary)).toHaveProperty("permissionPatterns", 1)
    if ("product_permission_requests" in input.wire) {
      expect(capabilities(binary)).toHaveProperty("productPermissionRequests", 1)
      expect(capabilities(binary)).toHaveProperty("productPermissionReplies", 1)
      expect(capabilities(binary)).toHaveProperty("productPermissionCancel", 1)
      expect(capabilities(binary)).toHaveProperty("productPermissionDiagnostics", 1)
      expect(capabilities(binary)).toHaveProperty("productPermissionAuto", 1)
    }
    if (input.accepted) expect(resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })?.binary).toBe(binary)
    if (!input.accepted)
      expect(() => resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })).toThrow("route schema")
  }
  for (const wire of [
    { saved_permission_migration: "1" },
    { permission_patterns: "1" },
    { permission_pattern_changes: "1" },
    { product_permission_requests: "1" },
    { product_permission_cancel: "1" },
    { product_permission_diagnostics: false },
    { product_permission_auto: "1" },
    { product_permission_replies: false },
    { routes_schema: "2" },
    { routesSchema: "2" },
    { routes_schema: 1, routesSchema: 2 },
    { routes_schema: 2, routesSchema: 1 },
  ]) {
    await Bun.write(binary, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ ...engine(2), ...wire })}'\n`)
    expect(capabilities(binary)).toBeUndefined()
    expect(() => resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })).toThrow("cannot report capabilities")
  }
})

test.skipIf(!process.env.MIAO_ENGINE_BIN)("the native executable reports a normalized route schema", () => {
  expect(capabilities(process.env.MIAO_ENGINE_BIN!)?.routesSchema).toBeGreaterThanOrEqual(2)
})

test.skipIf(process.platform === "win32")(
  "capability revisions reject malformed numeric contracts before selection",
  async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, "miao-engine")
    for (const wire of [
      { protocol: 2.5 },
      { protocol: Number.MAX_SAFE_INTEGER + 1 },
      { schema: -1 },
      { schema: 1.5 },
      { schema: Number.MAX_VALUE },
      { routes_schema: 2.5 },
      { routesSchema: -1 },
      { catalog: 0.5 },
      { catalog: -1 },
    ]) {
      await Bun.write(binary, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ ...engine(2), ...wire })}'\n`)
      await chmod(binary, 0o755)
      expect(capabilities(binary)).toBeUndefined()
      expect(() => resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })).toThrow("cannot report capabilities")
      expect(resolveEngine({ environment: {}, exists: () => true, probe: () => capabilities(binary) })).toBeUndefined()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "valid integer capability levels retain the existing compatibility policy",
  async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, "miao-engine")
    for (const protocol of [2, 3]) {
      await Bun.write(
        binary,
        `#!/bin/sh\nprintf '%s' '${JSON.stringify({ ...engine(protocol), schema: 0, routes_schema: 3, catalog: 0 })}'\n`,
      )
      await chmod(binary, 0o755)
      expect(resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })?.capabilities).toEqual({
        ...engine(protocol),
        schema: 0,
        routesSchema: 3,
        catalog: 0,
      })
    }
  },
)
