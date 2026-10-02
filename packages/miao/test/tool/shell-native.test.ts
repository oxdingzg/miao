import { beforeAll, describe, expect, test } from "bun:test"
import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"
import { Language, Parser, type Node } from "web-tree-sitter"
import { extract } from "@miao/core/shell/extract"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  shellAnalyze(
    command: string,
    dialect: string,
  ): {
    commands: Array<{ parts: Array<{ kind: string; text: string }>; tokens: string[]; source: string }>
  }
}

const native: Native | undefined = (() => {
  try {
    return require(nativePath) as Native
  } catch {
    return undefined
  }
})()

if (process.env.MIAO_NATIVE_REQUIRED === "1" && native === undefined) {
  throw new Error(`MIAO_NATIVE_REQUIRED=1 but ${nativePath} is missing; build crates/miao-native first`)
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

async function parsers() {
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
  await Parser.init({ locateFile: () => resolveWasm(treeWasm) })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const [bashLanguage, psLanguage] = await Promise.all([
    Language.load(resolveWasm(bashWasm)),
    Language.load(resolveWasm(psWasm)),
  ])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
}

const bashCommands = [
  "cd /tmp && rm -rf foo/bar",
  "echo hi > out.txt",
  "cat a.txt | grep foo",
  "cp -r src/ dest/",
  "FOO=1 ls -la",
  "echo $(date)",
  "if true; then echo yes; fi",
  "command: ls -la",
]

const psCommands = [
  "Get-Content -Path ./a.txt",
  "Copy-Item -Destination ./x -Path ./y",
  "Set-Location C:/tmp",
  "Remove-Item -Recurse -Force ./build",
]

const expected = (node: Node) =>
  extract(node).map((command) => ({
    parts: command.parts.map((part) => ({ kind: part.type, text: part.text })),
    tokens: command.tokens,
    source: command.source,
  }))

const withNative = native ? describe : describe.skip

withNative("native shell parity", () => {
  let parser: Awaited<ReturnType<typeof parsers>>

  beforeAll(async () => {
    parser = await parsers()
  })

  test("bash extraction matches the TypeScript walk", () => {
    for (const command of bashCommands) {
      const tree = parser.bash.parse(command)!
      expect(native!.shellAnalyze(command, "bash").commands).toEqual(expected(tree.rootNode))
    }
  })

  test("powershell extraction matches the TypeScript walk", () => {
    for (const command of psCommands) {
      const tree = parser.ps.parse(command)!
      expect(native!.shellAnalyze(command, "powershell").commands).toEqual(expected(tree.rootNode))
    }
  })
})
