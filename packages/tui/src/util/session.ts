/** Placeholders a generated title replaces. The catalog writes the timestamped
 * form; engine copies created before the shared placeholder may still carry
 * the bare native one. */
export function isDefaultTitle(title: string) {
  if (title === "New session") return true
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}
