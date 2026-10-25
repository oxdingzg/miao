export function sessionListScope(input: { scope?: "project"; projectID?: string; directory: string }) {
  if (input.scope === "project" && input.projectID) return { project: input.projectID }
  // An unavailable project identity must never widen the request to every
  // catalog Location: listing native Sessions can start their engine hosts.
  return { directory: input.directory }
}
