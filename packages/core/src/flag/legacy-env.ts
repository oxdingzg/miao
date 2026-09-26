// Backward compatibility for the opencode -> miao rename. Existing scripts may
// still set OPENCODE_* variables; mirror them onto MIAO_* before any flag is
// read. MIAO_* always wins when both are present.
for (const key of Object.keys(process.env)) {
  if (!key.startsWith("OPENCODE")) continue
  const next = "MIAO" + key.slice("OPENCODE".length)
  if (process.env[next] === undefined) process.env[next] = process.env[key]
}
