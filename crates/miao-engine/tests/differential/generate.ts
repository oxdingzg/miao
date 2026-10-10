// Generates the V4A patch differential corpus from the TypeScript reference
// implementation (packages/core/src/patch.ts). The expected file map in the
// corpus is produced by the reference, so the Rust engine is checked against an
// independent oracle rather than a hand-written expectation.
//
//   bun crates/miao-engine/tests/differential/generate.ts
//
// Writes crates/miao-engine/tests/differential/patch_corpus.json.
import { parse, deriveTs, joinBom } from "../../../../packages/core/src/patch.ts"

type Files = Record<string, string>
interface Case {
  name: string
  files: Files
  patch: string
  contract?: { reject?: boolean; result?: Files; reason: string }
}

const cases: Case[] = [
  {
    name: "update_exact",
    files: { "a.txt": "one\ntwo\nthree\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch",
  },
  {
    name: "update_context",
    files: { "a.txt": "alpha\nbeta\ngamma\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA\n*** End Patch",
  },
  {
    name: "update_append_at_eof",
    files: { "a.txt": "one\ntwo\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n two\n+three\n*** End Patch",
  },
  {
    name: "add_file",
    contract: { result: { "b.txt": "hello\nworld\n" }, reason: "New text files end with a newline, avoiding concatenated shell output." },
    files: {},
    patch: "*** Begin Patch\n*** Add File: b.txt\n+hello\n+world\n*** End Patch",
  },
  {
    name: "delete_file",
    files: { "a.txt": "gone\n" },
    patch: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch",
  },
  {
    name: "move_file",
    contract: { reject: true, reason: "The engine advertises strict Add/Update/Delete sections, not Move to; unsupported directives must fail before mutation." },
    files: { "a.txt": "content\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: c.txt\n@@\n-content\n+content\n*** End Patch",
  },
  {
    name: "bom_preserved",
    files: { "a.txt": "\uFEFFone\ntwo\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch",
  },
  {
    name: "multi_file",
    contract: { result: { "a.txt": "y\n", "b.txt": "new\n" }, reason: "New text files end with a newline." },
    files: { "a.txt": "x\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Add File: b.txt\n+new\n*** End Patch",
  },
  {
    name: "update_multiple_hunks",
    files: { "a.txt": "one\ntwo\nthree\nfour\n" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch",
  },
  {
    name: "update_no_trailing_newline",
    contract: { result: { "a.txt": "one\nTWO" }, reason: "Updates preserve the original final-newline convention rather than changing unrelated bytes." },
    files: { "a.txt": "one\ntwo" },
    patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+TWO\n*** End Patch",
  },
]

function applyPatch(files: Files, patch: string): Files {
  const hunks = parse(patch)
  const out: Files = { ...files }
  for (const hunk of hunks) {
    if (hunk.type === "add") {
      out[hunk.path] = hunk.contents
      continue
    }
    if (hunk.type === "delete") {
      delete out[hunk.path]
      continue
    }
    const original = out[hunk.path]
    if (original === undefined) throw new Error(`missing original ${hunk.path}`)
    const derived = deriveTs(hunk.path, hunk.chunks, original)
    const content = joinBom(derived.content, derived.bom)
    if (hunk.movePath) {
      delete out[hunk.path]
      out[hunk.movePath] = content
    } else {
      out[hunk.path] = content
    }
  }
  return out
}

// Generated exact-match cases widen the shared-contract coverage without
// deriving expected results from the Rust implementation.
const generated: Case[] = Array.from({ length: 32 }, (_, index) => {
  const before = `value-${index}-中文`
  const after = `fixed-${index}-中文`
  return {
    name: `generated-update-${index}`,
    files: { "a.txt": `header\n${before}\nfooter\n` },
    patch: `*** Begin Patch\n*** Update File: a.txt\n@@\n header\n-${before}\n+${after}\n footer\n*** End Patch`,
  }
})

const corpus = [...cases, ...generated].map((test) => ({
  name: test.name,
  files: test.files,
  patch: test.patch,
  reference: applyPatch(test.files, test.patch),
  contract: test.contract,
}))

const path = new URL("./patch_corpus.json", import.meta.url)
const text = JSON.stringify(corpus, null, 2) + "\n"
if (process.argv.includes("--check")) {
  if (await Bun.file(path).text() !== text) throw new Error("TS reference changed; review and regenerate the differential corpus")
  console.log(`reference corpus verified: ${corpus.length} cases`)
} else {
  await Bun.write(path, text)
  console.log(`wrote ${corpus.length} cases to ${path.pathname}`)
}
