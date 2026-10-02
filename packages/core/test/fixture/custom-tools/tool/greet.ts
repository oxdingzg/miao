import { tool } from "@opencode-ai/plugin/tool"

// Default export: registered under the file name, `greet`.
export default tool({
  description: "Greet someone",
  args: { name: tool.schema.string().describe("Who to greet") },
  async execute(args, context) {
    return `hello ${args.name} from ${context.agent} in ${context.directory}`
  },
})

// Named export: registered as `greet_secret`. It asks its own permission first.
export const secret = tool({
  description: "Reveal a secret",
  args: {},
  async execute(_args, context) {
    await context.ask({ permission: "greet-secret", patterns: ["vault"], always: ["vault"], metadata: {} })
    return { title: "secret", output: "the secret", metadata: { revealed: true } }
  },
})
