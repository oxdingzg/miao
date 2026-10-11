#!/usr/bin/env bun
// Malformed-wire fixture for the native snapshot/replay boundary.
const calls: string[] = []
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const scenario = process.env.MIAO_REPLAY_FIXTURE
const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let buffer = ""
for (;;) {
  const chunk = await reader.read()
  if (chunk.done) break
  buffer += decoder.decode(chunk.value, { stream: true })
  let index = buffer.indexOf("\n")
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    const request = JSON.parse(line)
    calls.push(request.method)
    const event = {
      session_id: request.params.session_id,
      seq: 1,
      kind: "session.mode",
      data: { mode: "build" },
      recorded_at_ms: 123,
    }
    const result =
      request.method === "calls"
        ? calls
        : request.method === "snapshot"
          ? { session_id: request.params.session_id, cursor: scenario === "cursor" ? -1 : 1 }
          : request.method === "events"
            ? scenario === "empty"
              ? []
              : [
                  {
                    ...event,
                    session_id: scenario === "session" ? "ses_foreign" : event.session_id,
                    seq: scenario === "gap" ? 2 : event.seq,
                    recorded_at_ms: scenario === "time" ? -1 : event.recorded_at_ms,
                  },
                ]
            : { accepted: true }
    send({ id: request.id, result })
    index = buffer.indexOf("\n")
  }
}
