import path from "path"
import { SessionCommand } from "../../../packages/core/src/session/command"

const cases = [
  "Read @src/main.ts and ask @reviewer.",
  "a@b.com @valid.txt",
  "`@skip` and @visible",
  "漢字@項目.md",
  "😀 @mixed.漢.md @worker",
  "@.hidden @../secret @a..b",
  "@a, @b. @c`",
  "@@worker @worker @worker",
  "@/absolute/path @C:\\file.txt",
  "@first\n@second\t@third",
  "!`echo @inside` and @outside",
  "foo_@skip 8@skip `@skip @take/child",
  "@. @.. @./x @../x @foo.bar.baz",
  "@ x @é.txt @你好.md",
  "@a\u0085b @c\ufeffd @e\u00a0f @g\u2028h",
]
const records = cases.map((text) => {
  const names = new Set<string>()
  return {
    text,
    expected: SessionCommand.files(text).flatMap((match) => {
      const name = match[1]
      if (!name || names.has(name)) return []
      names.add(name)
      return [
        {
          name,
          source: { type: "agent", name, text: match[0], start: match.index, end: match.index + match[0].length },
        },
      ]
    }),
  }
})
await Bun.write(
  path.join(import.meta.dir, "../tests/fixtures/command-reference-corpus.json"),
  JSON.stringify({ producer: "packages/core/src/session/command.ts: SessionCommand.files", records }, null, 2) + "\n",
)
