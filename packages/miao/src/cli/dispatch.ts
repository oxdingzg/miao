import { stat } from "node:fs/promises"
import path from "node:path"

export async function commandSelection(
  args: readonly string[],
  commands: readonly string[],
  directory = process.env.PWD ?? process.cwd(),
): Promise<"all" | "default" | readonly string[]> {
  const positional = args.find((arg) => !arg.startsWith("-"))
  if (positional !== undefined) {
    if (commands.includes(positional)) return [positional]
    // Bare words may name aliases declared inside lazy command modules.
    if (!path.isAbsolute(positional) && !positional.startsWith(".") && !/[/\\]/.test(positional)) return "all"
    const project = await stat(path.resolve(directory, positional)).then(
      (info) => info.isDirectory(),
      () => false,
    )
    return project ? "default" : "all"
  }
  if (args.includes("-v") || args.includes("--version")) return []
  return args.includes("-h") || args.includes("--help") ? "all" : "default"
}
