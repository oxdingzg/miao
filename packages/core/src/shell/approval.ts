/**
 * Permission resources and reusable "always allow" rules for a bash command,
 * matching the V1 shell tool: every command the script runs (including ones in
 * pipelines, lists, and substitutions) is its own resource, and approving
 * always saves each command's BashArity prefix, such as `git status *`.
 */
export * as ShellApproval from "./approval"

import { BashArity } from "../permission/arity"
import { extract } from "./extract"
import { ShellParser } from "./parser"

/** Commands that only change the working directory are not asked about on their own. */
const CWD = new Set(["cd", "chdir", "popd", "pushd"])

/**
 * Returns undefined when the command does not parse cleanly or runs no command
 * besides directory changes. The caller then keeps exact whole-command
 * approval: a parse error could hide a command from the split, so it must not
 * be approved through the rules of the commands that did parse.
 */
export async function bash(command: string) {
  const parser = await ShellParser.bash()
  const tree = parser.parse(command)
  if (!tree) return undefined
  const commands = tree.rootNode.hasError
    ? []
    : extract(tree.rootNode).filter((item) => item.tokens.length > 0 && !CWD.has(item.tokens[0]!))
  tree.delete()
  if (commands.length === 0) return undefined
  return {
    resources: [...new Set(commands.map((item) => item.source))],
    save: [...new Set(commands.map((item) => BashArity.prefix(item.tokens).join(" ") + " *"))],
  }
}
