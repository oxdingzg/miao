/** @jsxImportSource @opentui/solid */
import { addDefaultParsers, RGBA, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import parsers from "../../../src/parsers-config"
import { createDiffContextHighlighter } from "../../../src/util/diff-context-highlight"

addDefaultParsers(parsers.parsers)

const before = [
  "def summarize(samples):",
  '    """Return the median width.',
  "",
  "    后脸端面只作旁证，不再覆盖。",
  '    """',
  "    import statistics",
  "    ss = [float(x) for x in (samples or []) if x]",
  "    if not ss:",
  "        return None",
  "    return statistics.median(ss)",
  "",
].join("\n")
const after = before.replace("    if not ss:", "    sample_count = len(ss)\n    if not sample_count:")
const patch = createTwoFilesPatch("a.py", "a.py", before, after, undefined, undefined, { context: 4 })
const keyword = RGBA.fromHex("#ff0000")
const style = SyntaxStyle.fromStyles({ keyword: { fg: keyword }, default: { fg: RGBA.fromHex("#ffffff") } })

async function keywordSpans(client?: ReturnType<typeof createDiffContextHighlighter>, timeout = 5000) {
  const app = await testRender(
    () => (
      <diff diff={patch} view="unified" filetype="python" syntaxStyle={style} treeSitterClient={client} width="100%" />
    ),
    { width: 100, height: 20 },
  )
  try {
    const deadline = Date.now() + timeout
    const read = () =>
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.fg.equals(keyword))
        .map((span) => span.text.trim())
    while (Date.now() < deadline) {
      await app.renderOnce()
      if (read().includes("return")) break
      await Bun.sleep(25)
    }
    return read()
  } finally {
    app.renderer.destroy()
  }
}

test("a rendered diff that opens inside a docstring highlights its code with file context", async () => {
  const spans = await keywordSpans(createDiffContextHighlighter({ patch, current: after }))
  expect(spans).toContain("import")
  expect(spans).toContain("if")
  expect(spans).toContain("return")
}, 30000)

test("without file context the same diff loses keyword highlighting after the docstring", async () => {
  const spans = await keywordSpans(undefined, 1500)
  expect(spans).not.toContain("if")
}, 30000)
