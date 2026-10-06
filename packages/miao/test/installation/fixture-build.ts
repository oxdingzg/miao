import { InstallationExecutable } from "@miao/core/installation/executable"

if (process.argv.includes("--version")) {
  console.log("0.1.14")
  process.exit(0)
}
if (process.argv.includes("--build-id")) {
  console.log(InstallationExecutable.buildID)
  process.exit(0)
}
console.log(InstallationExecutable.buildID)
const reader = Bun.stdin.stream().getReader()
while (true) {
  const chunk = await reader.read()
  if (chunk.done) break
  if (!chunk.value.length) continue
  const child = Bun.spawn([InstallationExecutable.executable, "--build-id"], { stdout: "pipe" })
  console.log((await new Response(child.stdout).text()).trim())
  if (await child.exited) process.exit(1)
}
