const ts = require("typescript")
const fs = require("fs")
const path = require("path")
const cp = require("child_process")
const files = cp
  .execFileSync("git", ["ls-files", "packages"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((x) => /\.[cm]?tsx?$/.test(x))
const tracked = new Set(files)
const categories = [
  ["runner", "packages/core/src/session/runner"],
  ["execution", "packages/core/src/session/execution"],
  [
    "scheduling",
    "packages/core/src/session/run-coordinator",
    "packages/core/src/session/schedule",
    "packages/core/src/session/delegation",
    "packages/core/src/session/delegation-store",
  ],
  ["inbox", "packages/core/src/session/input", "packages/core/src/session/admission"],
  ["permission", "packages/core/src/permission"],
  ["placement", "packages/core/src/session/routing", "packages/core/src/session/engine-placement"],
]
function resolve(file, spec) {
  const stem = spec.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
    : spec.startsWith("@miao/core/")
      ? "packages/core/src/" + spec.slice("@miao/core/".length)
      : undefined
  if (!stem) return
  return [stem, stem + ".ts", stem + ".tsx", stem + "/index.ts"].find((x) => tracked.has(x))
}
function category(target) {
  return categories.find(([, ...roots]) => roots.some((x) => target === x + ".ts" || target.startsWith(x + "/")))?.[0]
}
const imports = []
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  function visit(node) {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (spec && ts.isStringLiteral(spec)) {
      const target = resolve(file, spec.text)
      const group = target && category(target)
      if (group && target !== file) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
        const names = clause?.namedBindings
        const typeOnly = Boolean(
          node.isTypeOnly ||
            clause?.isTypeOnly ||
            (clause &&
              !clause.name &&
              names &&
              ts.isNamedImports(names) &&
              names.elements.length &&
              names.elements.every((x) => x.isTypeOnly)),
        )
        imports.push({
          category: group,
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          target,
          specifier: spec.text,
          kind: ts.isExportDeclaration(node) ? "export" : ts.isCallExpression(node) ? "dynamic-import" : "import",
          typeOnly,
          scope: file.includes("/src/") ? "source" : "verification",
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
const counts = Object.fromEntries(
  categories.map(([name]) => [
    name,
    {
      sourceEdges: imports.filter((x) => x.category === name && x.scope === "source").length,
      verificationEdges: imports.filter((x) => x.category === name && x.scope === "verification").length,
    },
  ]),
)
const result = {
  sourceCommit: cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  method:
    "TypeScript AST: literal import/export declarations and literal dynamic imports in tracked packages/**/*.ts and tsx; @miao/core/* and relative module resolution. Self-namespace exports excluded. Source/verification classify by /src/ path. This is an import boundary inventory, not call-graph reachability or proof of runtime activation. Computed imports, require(), DI lookup and generated/third-party consumers require separate review.",
  categories: counts,
  runnerFiles: files.filter((x) => x.startsWith("packages/core/src/session/runner/")),
  edges: imports.sort(
    (a, b) => a.category.localeCompare(b.category) || a.file.localeCompare(b.file) || a.line - b.line,
  ),
}
fs.mkdirSync("docs/experiments/2026-10-28-ts-runner-retirement", { recursive: true })
fs.writeFileSync(
  "docs/experiments/2026-10-28-ts-runner-retirement/imports.json",
  JSON.stringify(result, null, 2) + "\n",
)
console.log(
  JSON.stringify({
    commit: result.sourceCommit,
    counts,
    runnerFiles: result.runnerFiles.length,
    edges: imports.length,
  }),
)
