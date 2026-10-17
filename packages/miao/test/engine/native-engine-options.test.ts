import { expect, test } from "bun:test"
import { nativeEngineOptions } from "@/engine/native-engine"
import { engineArgs } from "@/engine/client"

test("native coding receives only explicitly configured policy and endpoint", () => {
  expect(nativeEngineOptions({ MIAO_ENGINE_POLICY: "/tmp/policy.json" })).toBeUndefined()
  const baseline = nativeEngineOptions({ MIAO_ENGINE_BIN: "/tmp/engine", MIAO_ENGINE_MODEL: "fixture" })
  expect(baseline?.policyFile).toBeUndefined()
  expect(baseline?.endpoint).toBeUndefined()
  const configured = nativeEngineOptions({
    MIAO_ENGINE_BIN: "/tmp/engine",
    MIAO_ENGINE_MODEL: "fixture",
    MIAO_ENGINE_PROVIDER: "openai-chat",
    MIAO_ENGINE_POLICY: "/tmp/policy.json",
    MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:1234/chat/completions",
    MIAO_ENGINE_MODEL_ROUTES_CONFIG: "/host/model-routes.json",
  })
  if (!configured) throw new Error("native options missing")
  const args = engineArgs({ ...configured, db: "/tmp/engine.db", workspace: "/workspace" })
  expect(args[args.indexOf("--model-routes-config") + 1]).toBe("/host/model-routes.json")
  expect(args[args.indexOf("--policy") + 1]).toBe("/tmp/policy.json")
  expect(args[args.indexOf("--endpoint") + 1]).toBe("http://127.0.0.1:1234/chat/completions")
})
