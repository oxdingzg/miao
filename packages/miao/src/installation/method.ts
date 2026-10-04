export function isDirectInstall(executable: string, platform = process.platform) {
  const normalized = executable.replaceAll("\\", "/")
  const path = platform === "win32" ? normalized.toLowerCase() : normalized
  if (/(?:^|\/)\.(?:miao|local)\/bin\//.test(path)) return true
  return platform === "win32" && /(?:^|\/)programs\/miao\/miao(?:-bin)?\.exe$/.test(path)
}
