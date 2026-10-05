import { chromium } from "@playwright/test"
import { fileURLToPath } from "node:url"
import type { BrowserCheckpoint } from "../src/browser-checkpoint"

declare global {
  interface Window {
    openCheckpoints: typeof BrowserCheckpoint.open
  }
}

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/browser-checkpoint.ts", import.meta.url))],
  target: "browser",
})
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser checkpoint bundle failed")
const source = await bundle.outputs[0].text()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/state.js"
      ? new Response(source, { headers: { "content-type": "text/javascript" } })
      : new Response('<script type="module">import {open} from "/state.js";window.openCheckpoints=open</script>', {
          headers: { "content-type": "text/html" },
        }),
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}`)
  await page.waitForFunction(() => typeof window.openCheckpoints === "function")
  const result = await page.evaluate(async () => {
    const first = await window.openCheckpoints()
    const second = await window.openCheckpoints()
    const scope = {
      hubURL: "https://relay.example.invalid",
      accountID: "account_fixture",
      devicePublicKey: "B" + "a".repeat(86),
      hostID: "host_fixture",
      runtimeID: "runtime_fixture",
      grantID: "grant_fixture",
      grantVersion: 1,
      sessionID: "session_fixture",
    }
    const writes = await Promise.allSettled([
      first.commit(scope, { cursor: 42, state: JSON.stringify({ messages: ["完整会话页"] }) }, 0),
      second.commit(scope, { cursor: 43, state: JSON.stringify({ messages: ["并发完整页"] }) }, 0),
    ])
    const checkpoint = await first.read(scope)
    if (!checkpoint) throw new Error("Checkpoint was not committed")
    const isolation = await Promise.all([
      first.read({ ...scope, accountID: "different" }),
      first.read({ ...scope, runtimeID: "different" }),
      first.read({ ...scope, grantVersion: 2 }),
      first.read({ ...scope, sessionID: "different" }),
    ])
    const failures = await Promise.allSettled([
      first.commit(scope, { cursor: 0, state: "{}" }, checkpoint.revision),
      second.commit(scope, { cursor: 50, state: "{broken" }, checkpoint.revision),
    ])
    const unchanged = await first.read(scope)
    const draft = await first.saveDraft(scope, "尚未发送的输入", 0)
    await second.saveDraft(scope, "用户继续编辑的输入", draft.revision)
    const staleClear = await Promise.allSettled([first.saveDraft(scope, "", draft.revision)])
    const operationID = crypto.randomUUID()
    const operation = await first.prepareOperation(scope, {
      id: operationID,
      method: "session.prompt",
      payload: '{"text":"同一条输入"}',
    })
    const claims = await Promise.allSettled([
      first.transitionOperation(scope, operation.id, 1, "awaitingConfirmation"),
      second.transitionOperation(scope, operation.id, 1, "awaitingConfirmation"),
    ])
    const unknown = await first.transitionOperation(scope, operation.id, 2, "outcomeUnknown")
    const immutable = await Promise.allSettled([
      second.prepareOperation(scope, { id: operationID, method: "session.prompt", payload: '{"text":"修改后的输入"}' }),
    ])
    first.close()
    second.close()
    const restored = await window.openCheckpoints()
    const loaded = await restored.read(scope)
    const restoredDraft = await restored.readDraft(scope)
    const operations = await restored.operations(scope)
    const completed = await restored.transitionOperation(
      scope,
      operationID,
      unknown.revision,
      "completed",
      '{"accepted":true}',
    )
    const downgrade = await Promise.allSettled([
      restored.transitionOperation(scope, operationID, completed.revision, "outcomeUnknown"),
    ])
    const other = { ...scope, accountID: "other_account" }
    await restored.commit(other, { cursor: 7, state: "{}" }, 0)
    await restored.clearAccount(scope.hubURL, scope.accountID)
    const removed = await restored.read(scope)
    const retained = await restored.read(other)
    const removedOperations = await restored.operations(scope)
    const removedDraft = await restored.readDraft(scope)
    restored.close()
    const bounded = await window.openCheckpoints("miao.browser.operation.capacity")
    const entries = []
    for (let index = 0; index < 256; index++)
      entries.push(
        await bounded.prepareOperation(scope, { id: crypto.randomUUID(), method: "session.prompt", payload: "{}" }),
      )
    const overflow = await Promise.allSettled([
      bounded.prepareOperation(scope, { id: crypto.randomUUID(), method: "session.prompt", payload: "{}" }),
    ])
    await bounded.transitionOperation(scope, entries[0]!.id, 1, "rejected")
    await bounded.prepareOperation(scope, { id: crypto.randomUUID(), method: "session.prompt", payload: "{}" })
    const retainedEntries = await bounded.operations(scope)
    bounded.close()
    return {
      concurrent: writes.filter((write) => write.status === "fulfilled").length === 1,
      isolated: isolation.every((value) => value === undefined),
      rejected: failures.every((failure) => failure.status === "rejected"),
      atomic: unchanged?.cursor === checkpoint.cursor && unchanged?.state === checkpoint.state,
      persisted: loaded?.cursor === checkpoint.cursor && loaded?.state === checkpoint.state && loaded?.revision === 1,
      cleanup:
        removed === undefined && retained?.cursor === 7 && removedOperations.length === 0 && removedDraft === undefined,
      draftRestored: restoredDraft?.text === "用户继续编辑的输入" && staleClear[0]?.status === "rejected",
      operationClaim: claims.filter((claim) => claim.status === "fulfilled").length === 1,
      immutableOperation: immutable.every((claim) => claim.status === "rejected"),
      operationRestored:
        operations.length === 1 && operations[0]?.id === operationID && operations[0]?.status === "outcomeUnknown",
      terminalStable: downgrade.every((claim) => claim.status === "rejected"),
      boundedOperations:
        overflow[0]?.status === "rejected" &&
        retainedEntries.length === 256 &&
        retainedEntries.filter((entry) => entry.status === "prepared").length === 256,
    }
  })
  if (Object.values(result).some((value) => value !== true)) throw new Error("Browser checkpoint invariant failed")
  console.log(
    "Browser state: atomic checkpoints, operation fencing, immutable payloads, recovery, capacity and cleanup passed",
  )
} finally {
  await browser?.close()
  server.stop(true)
}
