import { addDefaultParsers, getTreeSitterClient } from "@opentui/core"
import { expect, test } from "bun:test"
import parsers from "../../src/parsers-config"
import { filetype } from "../../src/util/filetype"
import { shellSegments } from "../../src/util/shell-highlight"

addDefaultParsers(parsers.parsers)

test("a heredoc fed to python highlights its body as python", () => {
  expect(shellSegments("python3 - <<'PY'\nimport json\nprint(json.dumps({}))\nPY\necho done")).toEqual([
    { filetype: "bash", content: "python3 - <<'PY'" },
    { filetype: "python", content: "import json\nprint(json.dumps({}))" },
    { filetype: "bash", content: "PY\necho done" },
  ])
})

test("a heredoc written to a file takes the file's language", () => {
  expect(shellSegments('cat > config.json <<EOF\n{"a": 1}\nEOF')).toEqual([
    { filetype: "bash", content: "cat > config.json <<EOF" },
    { filetype: "json", content: '{"a": 1}' },
    { filetype: "bash", content: "EOF" },
  ])
  expect(shellSegments("cat <<'EOF' > src/a.ts\nconst a = 1\nEOF")[1]).toEqual({
    filetype: "typescript",
    content: "const a = 1",
  })
})

test("an interpreter path, version suffix and indented terminator are recognised", () => {
  expect(shellSegments("/usr/bin/python3.12 <<-PY\n\tprint(1)\n\tPY")[1]).toEqual({
    filetype: "python",
    content: "\tprint(1)",
  })
  expect(shellSegments("node - <<'JS'\nconsole.log(1)\nJS")[1].filetype).toBe("typescript")
})

test("plain commands, unknown targets and unterminated heredocs stay shell", () => {
  expect(shellSegments("ls -la && git status")).toEqual([{ filetype: "bash", content: "ls -la && git status" }])
  expect(shellSegments("cat <<EOF\nhello\nEOF")).toEqual([{ filetype: "bash", content: "cat <<EOF\nhello\nEOF" }])
  expect(shellSegments("python3 - <<'PY'\nprint(1)")).toEqual([
    { filetype: "bash", content: "python3 - <<'PY'\nprint(1)" },
  ])
  expect(shellSegments("python3 x.py <<EOF\nabc\nEOF")).toEqual([
    { filetype: "bash", content: "python3 x.py <<EOF\nabc\nEOF" },
  ])
  expect(shellSegments("python3 -u - 2>&1 <<EOF\nprint(1)\nEOF")[1].filetype).toBe("python")
})

test("shell segments and shell files use a filetype that has a parser", async () => {
  const client = getTreeSitterClient()
  await client.initialize()
  const segments = shellSegments("if [ -f x ]; then python3 - <<'PY'\nimport os\nPY\nfi")
  for (const segment of segments) {
    const result = await client.highlightOnce(segment.content, segment.filetype)
    expect(result.warning).toBeUndefined()
    expect(result.highlights?.length ?? 0).toBeGreaterThan(0)
  }
  expect(filetype("deploy.sh")).toBe("bash")
}, 60000)
