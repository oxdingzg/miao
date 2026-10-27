import { type JSX, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createMarkdownBudget, markdownCost } from "../util/markdown-budget"

const budgets = new WeakMap<object, ReturnType<typeof createMarkdownBudget>>()

/** Fenced code keeps its syntax colors even when the message itself is too
 * expensive to parse as Markdown: one `<code>` per fence costs one renderable
 * instead of the block tree the estimator rejected. */
const CODE_LIMIT = 12

const FENCE_FILETYPES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  hs: "haskell",
  ml: "ocaml",
  ex: "elixir",
  fs: "fsharp",
  golang: "go",
}

// Grammars the TUI registers, plus OpenTUI's built-ins; anything else renders
// as plain text so an unregistered filetype cannot allocate a dead renderable.
const GRAMMARS = new Set([
  "bash",
  "c",
  "clojure",
  "cpp",
  "csharp",
  "css",
  "diff",
  "elixir",
  "fsharp",
  "go",
  "haskell",
  "hcl",
  "html",
  "java",
  "javascript",
  "json",
  "julia",
  "kotlin",
  "lua",
  "make",
  "markdown",
  "nix",
  "ocaml",
  "php",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "swift",
  "toml",
  "typescript",
  "vim",
  "vue",
  "xml",
  "yaml",
  "agda",
])

type Segment = { text: string; filetype?: string }

/**
 * The plain fallback, split so fenced code still highlights. Fence markers are
 * dropped: the reader gains colors and loses three backticks.
 */
function segments(content: string, syntax: boolean): Segment[] {
  const out: Segment[] = []
  let buffer: string[] = []
  let fence: { marker: string; filetype?: string } | undefined
  let codes = 0
  const flush = (filetype?: string) => {
    if (buffer.length === 0) return
    out.push({ text: buffer.join("\n"), filetype })
    buffer = []
  }
  for (const line of content.split(/\r\n?|\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) {
        flush(fence.filetype)
        fence = undefined
        continue
      }
      buffer.push(line)
      continue
    }
    if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      flush(undefined)
      const language = match[2].trim().split(/\s+/)[0]?.toLowerCase() ?? ""
      const filetype = FENCE_FILETYPES[language] ?? language
      fence = { marker: match[1], filetype: syntax && codes < CODE_LIMIT && GRAMMARS.has(filetype) ? filetype : undefined }
      if (fence.filetype) codes++
      continue
    }
    buffer.push(line)
  }
  flush(fence?.filetype)
  return out
}

/** Keep all source text readable when rich Markdown would exhaust native handles. */
export function Markdown(props: JSX.IntrinsicElements["markdown"]) {
  const renderer = useRenderer()
  let budget = budgets.get(renderer)
  if (!budget) {
    budget = createMarkdownBudget()
    budgets.set(renderer, budget)
  }
  const cost = createMemo(() => markdownCost(props.content ?? ""))
  const [rich, setRich] = createSignal(false)
  const lease = budget.lease(cost(), setRich)
  createEffect(() => lease.update(cost()))
  onCleanup(() => lease.release())
  const plain = createMemo(() => segments(props.content ?? "", props.syntaxStyle !== undefined))
  return (
    <Show
      when={rich()}
      fallback={
        <box
          flexDirection="column"
          width={props.width}
          flexGrow={props.flexGrow}
          flexShrink={props.flexShrink}
        >
          <For each={plain()}>
            {(segment) =>
              segment.filetype === undefined ? (
                <text fg={props.fg} bg={props.bg}>
                  {segment.text}
                </text>
              ) : (
                <code
                  conceal={false}
                  fg={props.fg}
                  filetype={segment.filetype}
                  syntaxStyle={props.syntaxStyle}
                  content={segment.text}
                />
              )
            }
          </For>
        </box>
      }
    >
      <markdown {...props} />
    </Show>
  )
}
