import { fileURLToPath } from "node:url"
import path from "node:path"
const directory = fileURLToPath(new URL("../web/", import.meta.url))
const output = fileURLToPath(new URL("../dist/web/", import.meta.url))
const result = await Bun.build({
  entrypoints: [path.join(directory, "client.ts")],
  outdir: output,
  target: "browser",
  minify: true,
  naming: "control.js",
})
if (!result.success) throw new Error("Remote web build failed")
await Promise.all([
  Bun.write(path.join(output, "index.html"), Bun.file(path.join(directory, "index.html"))),
  Bun.write(path.join(output, "control.css"), Bun.file(path.join(directory, "control.css"))),
])
console.log("Remote web assets built")
