const file = Bun.argv[2]
const content = await Bun.file(file).text()
await Bun.write(
  file,
  content
    .replace(/^\uFEFF+/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("unformatted", "formatted"),
)
