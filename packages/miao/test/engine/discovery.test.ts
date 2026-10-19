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
  ).toThrow("requires 2")
  expect(() =>
    resolveEngine({ environment: { MIAO_ENGINE_BIN: "/missing" }, probe: () => engine(2), exists: () => false }),
  ).toThrow("unknown")
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
      "#!/bin/sh\nprintf '%s' '{\"name\":\"miao-engine\",\"version\":\"9.9.9\",\"protocol\":2,\"schema\":12}'\n",
    )
    await chmod(script, 0o755)
    expect(capabilities(script)).toEqual(engine(2))
    await Bun.write(script, "#!/bin/sh\nprintf '%s' 'not json'\n")
    expect(capabilities(script)).toBeUndefined()
  },
  10_000,
)
