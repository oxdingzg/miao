// A history read can include fragments still queued by the SDK's event batch.
// Rebuild an observed stream from its start instead of appending those fragments
// to the already-ahead snapshot. Keep snapshots ahead of that stream visible.
export function createStreamText() {
  const streams = new Map<string, { text: string; ended: boolean; completed?: number; release?: boolean }>()
  const key = (sessionID: string, messageID: string, partID: string) => `${sessionID}:${messageID}:${partID}`
  const scope = (sessionID: string, messageID?: string) =>
    messageID === undefined ? `${sessionID}:` : `${sessionID}:${messageID}:`

  return {
    start(sessionID: string, messageID: string, partID: string) {
      const id = key(sessionID, messageID, partID)
      if (!streams.has(id)) streams.set(id, { text: "", ended: false })
    },
    reconcile(sessionID: string, messageID: string, partID: string, current: string) {
      const stream = streams.get(key(sessionID, messageID, partID))
      if (!stream) return current
      return stream.ended || !current.startsWith(stream.text) ? stream.text : current
    },
    append(sessionID: string, messageID: string, partID: string, delta: string, current?: string) {
      const stream = streams.get(key(sessionID, messageID, partID))
      // An attached client may have missed the start; it cannot infer a stream
      // origin by removing repeated words, which may be legitimate model text.
      if (!stream) return current === undefined ? undefined : current + delta
      if (!stream.ended) stream.text += delta
      if (current === undefined) return undefined
      return stream.ended || !current.startsWith(stream.text) ? stream.text : current
    },
    end(sessionID: string, messageID: string, partID: string, text: string, completed: number) {
      streams.set(key(sessionID, messageID, partID), { text, ended: true, completed })
    },
    completed(sessionID: string, messageID: string, partID: string) {
      return streams.get(key(sessionID, messageID, partID))?.completed
    },
    endMessage(sessionID: string, messageID?: string) {
      const prefix = scope(sessionID, messageID)
      for (const [id, stream] of streams) {
        if (id.startsWith(prefix)) stream.release = true
      }
    },
    releaseEnded(sessionID: string, messageID?: string) {
      const prefix = scope(sessionID, messageID)
      for (const [id, stream] of streams) {
        if ((stream.ended || stream.release) && id.startsWith(prefix)) streams.delete(id)
      }
    },
    clear(sessionID: string, messageID?: string) {
      const prefix = scope(sessionID, messageID)
      for (const id of streams.keys()) {
        if (id.startsWith(prefix)) streams.delete(id)
      }
    },
  }
}
