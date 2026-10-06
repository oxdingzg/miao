import { describe, expect, test } from "bun:test"
import { formatAssistantHeader, formatMessage, formatPart, formatTranscript } from "../../src/util/transcript"
import type { Provider, TranscriptAssistantMessage } from "@miao/schema/view-models"
import { testAssistantMessage, testTextPart, testUserMessage } from "../lib/v2-message"

const providers: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "api",
    env: [],
    options: {},
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-20250514",
          url: "https://example.com/claude-sonnet-4-20250514",
          npm: "@ai-sdk/anthropic",
        },
        name: "Claude Sonnet 4",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: true,
            video: false,
            pdf: true,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 200_000,
          output: 8_192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-05-14",
      },
    },
  },
]

describe("transcript", () => {
  describe("formatAssistantHeader", () => {
    const baseMsg: TranscriptAssistantMessage = testAssistantMessage({
      id: "msg_123",
      agent: "build",
      model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
      cost: 0.001,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      created: 1000000,
      completed: 1005400,
    })

    test("includes metadata when enabled", () => {
      const result = formatAssistantHeader(baseMsg, true)
      expect(result).toBe("## Assistant (Build · claude-sonnet-4-20250514 · 5.4s)\n\n")
    })

    test("uses model display name when available", () => {
      const result = formatAssistantHeader(baseMsg, true, providers)
      expect(result).toBe("## Assistant (Build · Claude Sonnet 4 · 5.4s)\n\n")
    })

    test("excludes metadata when disabled", () => {
      const result = formatAssistantHeader(baseMsg, false)
      expect(result).toBe("## Assistant\n\n")
    })

    test("handles missing completed time", () => {
      const msg = { ...baseMsg, time: { created: 1000000 } }
      const result = formatAssistantHeader(msg as TranscriptAssistantMessage, true)
      expect(result).toBe("## Assistant (Build · claude-sonnet-4-20250514)\n\n")
    })

    test("titlecases agent name", () => {
      const msg = { ...baseMsg, agent: "plan" }
      const result = formatAssistantHeader(msg, true)
      expect(result).toContain("Plan")
    })
  })

  describe("formatPart", () => {
    const options = { thinking: true, toolDetails: true, assistantMetadata: true }

    test("formats text part", () => {
      const part = testTextPart("part_1", "Hello world")
      const result = formatPart(part, options)
      expect(result).toBe("Hello world\n\n")
    })

    test("formats reasoning when thinking enabled", () => {
      const part = {
        type: "reasoning" as const,
        id: "part_1",
        text: "Let me think...",
        time: { created: 1000 },
      }
      const result = formatPart(part, options)
      expect(result).toBe("_Thinking:_\n\nLet me think...\n\n")
    })

    test("skips reasoning when thinking disabled", () => {
      const part = {
        type: "reasoning" as const,
        id: "part_1",
        text: "Let me think...",
        time: { created: 1000 },
      }
      const result = formatPart(part, { ...options, thinking: false })
      expect(result).toBe("")
    })

    test("formats tool part with details", () => {
      const part = {
        type: "tool" as const,
        id: "part_1",
        name: "bash",
        time: { created: 1000 },
        state: {
          status: "completed" as const,
          input: { command: "ls" },
          structured: {},
          content: [{ type: "text" as const, text: "file1.txt\nfile2.txt" }],
        },
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Tool: bash**")
      expect(result).toContain("**Input:**")
      expect(result).toContain('"command": "ls"')
      expect(result).toContain("**Output:**")
      expect(result).toContain("file1.txt")
    })

    test("formats tool output containing triple backticks without breaking markdown", () => {
      const part = {
        type: "tool" as const,
        id: "part_1",
        name: "bash",
        time: { created: 1000 },
        state: {
          status: "completed" as const,
          input: { command: "echo '```hello```'" },
          structured: {},
          content: [{ type: "text" as const, text: "```hello```" }],
        },
      }
      const result = formatPart(part, options)
      // The tool header should not be inside a code block
      expect(result).toStartWith("**Tool: bash**\n")
      // Input and output should each be in their own code blocks
      expect(result).toContain("**Input:**\n```json")
      expect(result).toContain("**Output:**\n```\n```hello```\n```")
    })

    test("formats tool part without details when disabled", () => {
      const part = {
        type: "tool" as const,
        id: "part_1",
        name: "bash",
        time: { created: 1000 },
        state: {
          status: "completed" as const,
          input: { command: "ls" },
          structured: {},
          content: [{ type: "text" as const, text: "file1.txt" }],
        },
      }
      const result = formatPart(part, { ...options, toolDetails: false })
      expect(result).toContain("**Tool: bash**")
      expect(result).not.toContain("**Input:**")
      expect(result).not.toContain("**Output:**")
    })

    test("formats tool error", () => {
      const part = {
        type: "tool" as const,
        id: "part_1",
        name: "bash",
        time: { created: 1000 },
        state: {
          status: "error" as const,
          input: { command: "invalid" },
          content: [],
          structured: {},
          error: { type: "unknown" as const, message: "Command failed" },
        },
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Error:**")
      expect(result).toContain("Command failed")
    })
  })

  describe("formatMessage", () => {
    const options = { thinking: true, toolDetails: true, assistantMetadata: true, providers }

    test("formats user message", () => {
      const msg = {
        id: "msg_123",
        type: "user" as const,
        text: "Hello",
        time: { created: 1000000 },
      }
      const result = formatMessage(msg, options)
      expect(result).toContain("## User")
      expect(result).toContain("Hello")
    })

    test("formats assistant message with metadata", () => {
      const msg = testAssistantMessage({
        id: "msg_123",
        agent: "build",
        model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
        cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        created: 1000000,
        completed: 1005400,
        content: [testTextPart("p1", "Hi there")],
      })
      const result = formatMessage(msg, options)
      expect(result).toContain("## Assistant (Build · Claude Sonnet 4 · 5.4s)")
      expect(result).toContain("Hi there")
    })
  })

  describe("formatTranscript", () => {
    test("formats complete transcript", () => {
      const session = {
        id: "ses_abc123",
        title: "Test Session",
        time: { created: 1000000000000, updated: 1000000001000 },
      }
      const messages = [
        testUserMessage({ id: "msg_1", text: "Hello", created: 1000000000000 }),
        testAssistantMessage({
          id: "msg_2",
          agent: "build",
          model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          created: 1000000000100,
          completed: 1000000000600,
          content: [testTextPart("p2", "Hi!")],
        }),
      ]
      const options = {
        thinking: false,
        toolDetails: false,
        assistantMetadata: true,
        providers,
      }

      const result = formatTranscript(session, messages, options)

      expect(result).toContain("# Test Session")
      expect(result).toContain("**Session ID:** ses_abc123")
      expect(result).toContain("## User")
      expect(result).toContain("Hello")
      expect(result).toContain("## Assistant (Build · Claude Sonnet 4 · 0.5s)")
      expect(result).toContain("Hi!")
      expect(result).toContain("---")
    })

    test("orders messages by creation time and preserves part order", () => {
      const message = (id: string, created: number, parts: string[]) =>
        testUserMessage({
          id,
          text: parts.join("\n"),
          created,
        })
      const result = formatTranscript(
        { id: "ses_abc123", title: "Order", time: { created: 1, updated: 2 } },
        [message("msg_a", 30, ["third"]), message("msg_z", 10, ["first", "second"])],
        { thinking: false, toolDetails: false, assistantMetadata: false },
      )

      expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"))
      expect(result.indexOf("second")).toBeLessThan(result.indexOf("third"))
    })

    test("falls back to raw model id when provider data is missing", () => {
      const session = {
        id: "ses_abc123",
        title: "Test Session",
        time: { created: 1000000000000, updated: 1000000001000 },
      }
      const messages = [
        testAssistantMessage({
          id: "msg_1",
          agent: "build",
          model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          created: 1000000000100,
          completed: 1000000000600,
          content: [testTextPart("p1", "Response")],
        }),
      ]

      const result = formatTranscript(session, messages, {
        thinking: false,
        toolDetails: false,
        assistantMetadata: true,
      })

      expect(result).toContain("## Assistant (Build · claude-sonnet-4-20250514 · 0.5s)")
    })

    test("formats transcript without assistant metadata", () => {
      const session = {
        id: "ses_abc123",
        title: "Test Session",
        time: { created: 1000000000000, updated: 1000000001000 },
      }
      const messages = [
        testAssistantMessage({
          id: "msg_1",
          agent: "build",
          model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
          cost: 0.001,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          created: 1000000000100,
          completed: 1000000000600,
          content: [testTextPart("p1", "Response")],
        }),
      ]
      const options = { thinking: false, toolDetails: false, assistantMetadata: false }

      const result = formatTranscript(session, messages, options)

      expect(result).toContain("## Assistant\n\n")
      expect(result).not.toContain("Build")
      expect(result).not.toContain("claude-sonnet-4-20250514")
    })
  })
})
