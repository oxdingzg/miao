/** Messages that arrived after the reader left the live tail. */
export function messagesAfter<T extends { id: string }>(messages: readonly T[], mark: string | undefined) {
  if (mark === undefined) return 0
  const index = messages.map((message) => message.id).lastIndexOf(mark)
  // A window that no longer holds the mark cannot be diffed against it, so
  // everything it shows counts as new rather than reporting nothing.
  return index === -1 ? messages.length : messages.length - index - 1
}
