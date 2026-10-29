import { expect, test } from "bun:test"
import path from "node:path"
import { PermissionClassifier } from "@miao/core/permission/classifier"
import { EngineClient, type EngineEvent } from "@/engine/client"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "native host auto mode matches the actual host classifier and keeps manual asks",
  async () => {
    if (!binary) throw new Error("native engine required")
    expect(await Bun.$`${binary} --capabilities`.json()).toMatchObject({ product_permission_auto: 1 })
    await using tmp = await tmpdir()
    const cases: {
      name: string
      action: "edit" | "bash"
      resources: string[]
      metadata?: Record<string, unknown>
      deny?: boolean
    }[] = [
      { name: "workspace-edit", action: "edit", resources: [path.join(tmp.path, "src/file.rs")] },
      {
        name: "relative-inside",
        action: "edit",
        resources: [path.relative(process.cwd(), path.join(tmp.path, "relative.rs"))],
      },
      { name: "relative-outside", action: "edit", resources: ["src/file.rs"] },
      { name: "root-itself", action: "edit", resources: [tmp.path] },
      { name: "outside", action: "edit", resources: [path.join(tmp.path, "../outside.rs")] },
      { name: "env", action: "edit", resources: [path.join(tmp.path, ".env")] },
      { name: "git-metadata", action: "edit", resources: [path.join(tmp.path, ".git/config")] },
      { name: "protected-ancestor", action: "edit", resources: [`${tmp.path}/.ssh/../ordinary.rs`] },
      { name: "double-dot-name", action: "edit", resources: [path.join(tmp.path, "..ordinary.rs")] },
      { name: "deny-edit", action: "edit", resources: [path.join(tmp.path, "denied.rs")], deny: true },
      { name: "git-status", action: "bash", resources: ["git status"] },
      { name: "listing", action: "bash", resources: ["ls -la"] },
      { name: "read-secret", action: "bash", resources: ["cat .env"] },
      { name: "redirect", action: "bash", resources: ["echo value > file"] },
      { name: "remove", action: "bash", resources: ["rm -rf file"] },
      { name: "branch-write", action: "bash", resources: ["git branch new-branch"] },
      { name: "multiple-commands", action: "bash", resources: ["pwd", "echo ok"] },
      { name: "stdin", action: "bash", resources: ["ls"], metadata: { stdin: null } },
      { name: "deny-bash", action: "bash", resources: ["echo denied"], deny: true },
    ]
    const expected = await Promise.all(
      cases.map(async (item) =>
        item.deny
          ? "denied"
          : (item.action === "edit"
                ? PermissionClassifier.edit(item.resources, tmp.path)
                : item.metadata?.stdin !== undefined
                  ? "unknown"
                  : await PermissionClassifier.bash(item.resources)) === "safe"
            ? "allowed"
            : "pending",
      ),
    )
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: "host-call", type: "function", function: { name: "host_probe", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const policyFile = path.join(tmp.path, "policy.json")
    const productToolsFile = path.join(tmp.path, "tools.json")
    await Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] }))
    await Bun.write(
      productToolsFile,
      JSON.stringify({
        host_context: { directory: tmp.path, cwd: process.cwd() },
        tools: [
          {
            name: "host_probe",
            description: "Host mode fixture",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    )
    const ready = new Map(["auto", "manual"].map((mode) => [mode, Promise.withResolvers<void>()]))
    const finished = new Map(["auto", "manual"].map((mode) => [mode, Promise.withResolvers<void>()]))
    const release = Promise.withResolvers<void>()
    const client: EngineClient = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
      policyFile,
      productToolsFile,
      async onProductTool(call) {
        try {
          if (call.messageSeq === undefined) throw new Error("missing source identity")
          const source = {
            session_id: call.sessionID,
            bridge_id: call.bridgeID,
            call_id: call.callID,
            message_seq: call.messageSeq,
          }
          for (const [index, item] of cases.entries()) {
            const result = (await client.request("product_permission_admit", {
              source,
              input: {
                request_id: `${call.sessionID}-${item.name}`,
                facts: { actions: [item.action], resources: item.resources },
                metadata: item.metadata,
              },
            })) as { state: string; reason: string | null }
            const effect = item.deny ? "denied" : call.sessionID === "manual" ? "pending" : expected[index]
            expect({ name: item.name, effect: result.state }).toEqual({ name: item.name, effect })
            if (effect === "allowed") expect(result.reason).toBe("auto_allowed")
          }
          const pending = (await client.request("product_permission_pending", {
            session_id: call.sessionID,
          })) as unknown[]
          expect(pending.length).toBe(
            cases.filter((item, index) => !item.deny && (call.sessionID === "manual" || expected[index] === "pending"))
              .length,
          )
          ready.get(call.sessionID)!.resolve()
          await release.promise
          return {}
        } catch (error) {
          ready.get(call.sessionID)!.reject(error)
          throw error
        }
      },
    })
    const onFinished = (event: EngineEvent) => {
      if (event.kind === "run.finished") finished.get(event.session_id)?.resolve()
    }
    client.onEvent(onFinished)
    try {
      for (const mode of ["auto", "manual"]) {
        await client.admit({ session_id: mode, input_id: mode, prompt: "call host", delivery: "steer" }, false)
        await client.request("select_agent", {
          session_id: mode,
          agent: {
            name: mode,
            ...(mode === "auto" ? { permission_mode: "auto" } : {}),
            ordered_permissions: {
              semantics: "ordered-wildcard-v1",
              rules: [
                { action: "*", resource: "*", effect: "allow" },
                { action: "edit", resource: "*", effect: "ask" },
                { action: "bash", resource: "*", effect: "ask" },
                { action: "edit", resource: "*denied*", effect: "deny" },
                { action: "bash", resource: "*denied*", effect: "deny" },
              ],
            },
          },
        })
        await client.subscribe(mode, 0)
        await client.request("resume", { session_id: mode })
        await Promise.race([
          ready.get(mode)!.promise,
          Bun.sleep(10_000).then(() => {
            throw new Error(`mode fixture timed out: ${mode}`)
          }),
        ])
      }
      for (const mode of ["auto", "manual"]) {
        await client.cancel(mode)
        await Promise.race([
          finished.get(mode)!.promise,
          Bun.sleep(10_000).then(() => {
            throw new Error(`mode cancellation timed out: ${mode}`)
          }),
        ])
        expect(await client.request("product_permission_pending", { session_id: mode })).toEqual([])
      }
    } finally {
      client.offEvent(onFinished)
      release.resolve()
      await client.close()
      await provider.stop(true)
    }
  },
  30_000,
)
