/** @jsxImportSource @opentui/solid */
/**
 * Reproducer for #26560 — TUI crashes with
 *   `TypeError: undefined is not an object (evaluating 'f.data.map')`
 * when entering a session whose messages endpoint returns a non-2xx.
 * The V2 read path calls the messages endpoint with `throwOnError`, so the
 * failure must surface as the SDK's `Error` instead of a `TypeError` from
 * reading a property off `undefined`.
 */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount } from "./sync-fixture"

const sessionID = "ses_undef"

describe("tui sync (#26560)", () => {
  test("entering a session whose messages endpoint errors does not crash sync", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionPayload = {
      id: sessionID,
      projectID: "proj_test",
      title: "broken",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      location: { directory },
      subpath: "",
    }
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: sessionPayload })
      if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({}, { status: 500 })
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/diff`) return json({ data: [] })
      return undefined
    }, tmp.path)

    try {
      const error = await sync.session.sync(sessionID).then(
        () => undefined,
        (error: unknown) => error,
      )
      // The endpoint failure must not be an unguarded property read on missing
      // data; it surfaces as a normal error the route caller can report.
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(TypeError)
    } finally {
      app.renderer.destroy()
    }
  })
})
