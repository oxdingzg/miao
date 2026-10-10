import path from "node:path"

/** Use the immutable executable path: a preview symlink may later point at a
 * different build/channel, while the stable command opens a different DB. */
export function resumeCommand(executable: string, entrypoint?: string) {
  const source = /^bun(?:\.exe)?$/i.test(path.basename(executable)) && entrypoint
  return (source ? [executable, "--conditions=browser", path.resolve(entrypoint)] : [executable])
    .map((argument) => (/^[\w/.:=\\-]+$/.test(argument) ? argument : `"${argument.replace(/["\\$`]/g, "\\$&")}"`))
    .join(" ")
}
