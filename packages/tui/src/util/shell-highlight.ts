import path from "node:path"
import { filetype } from "./filetype"

const INTERPRETERS: Record<string, string> = {
  python: "python",
  node: "typescript",
  bun: "typescript",
  deno: "typescript",
  ruby: "ruby",
  php: "php",
  lua: "lua",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
}

// Split a shell command so heredoc bodies highlight in their own language.
// Highlighted as one shell script, `python3 - <<'PY' ... PY` colours the
// whole program as a single string. A body is retargeted when its line names
// a file it is written to (`cat > a.py <<EOF`) or an interpreter it is fed to;
// anything else, including an unterminated heredoc, stays shell.
export function shellSegments(command: string) {
  const lines = command.split("\n")
  const segments: { filetype: string; content: string }[] = []
  const shell: string[] = []
  const flush = () => {
    if (shell.length > 0) segments.push({ filetype: "bash", content: shell.splice(0).join("\n") })
  }
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    shell.push(line)
    const heredoc = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line)
    const language = heredoc ? heredocLanguage(line.slice(0, heredoc.index), line.slice(heredoc.index)) : undefined
    const end = heredoc
      ? lines.findIndex(
          (candidate, position) =>
            position > index && (heredoc[1] ? candidate.replace(/^\t+/, "") : candidate) === heredoc[3],
        )
      : -1
    if (!language || end < 0) {
      index++
      continue
    }
    flush()
    segments.push({ filetype: language, content: lines.slice(index + 1, end).join("\n") })
    shell.push(lines[end])
    index = end + 1
  }
  flush()
  return segments
}

function heredocLanguage(before: string, after: string) {
  const target = /(?:^|\s)(?:>>?|tee(?:\s+-a)?\s)\s*([^\s<>|;&]+)/.exec(`${before} ${after}`)?.[1]
  const written = target ? filetype(target) : undefined
  if (written && written !== "none") return written
  // The body is code only when the interpreter reads its program from stdin:
  // `python3 - <<PY` is code, `python3 script.py <<EOF` feeds the script data.
  const words = before.trim().split(/\s+/)
  const position = words.findIndex((word) => INTERPRETERS[path.basename(word).replace(/\d+(\.\d+)*$/, "")])
  const program =
    position >= 0 && words.slice(position + 1).every((word) => /^(-|\d*[<>])/.test(word))
      ? path.basename(words[position]).replace(/\d+(\.\d+)*$/, "")
      : undefined
  return program ? INTERPRETERS[program] : undefined
}
