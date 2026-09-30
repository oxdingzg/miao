// This is a display-only view of the envelope emitted by send_message. Keep
// the original prompt text intact for model history, copying and export.
export function parseSessionMessage(text: string) {
  const match = /^<message from session="(ses_[A-Za-z0-9_-]+)">\r?\n([\s\S]*?)\r?\n<\/message>$/.exec(text)
  if (!match) return
  return { sessionID: match[1], body: match[2] }
}
