import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"
import path from "path"
import { pathToFileURL } from "node:url"
import { readdir } from "node:fs/promises"

const server = await createOpencodeServer()
const client = createOpencodeClient({ baseUrl: server.url, throwOnError: true })

try {
  await Promise.all(
    (await readdir("packages/core/src"))
      .filter((file) => file.endsWith(".ts"))
      .map(async (file) => {
        const created = await client.v2.session.create(
          { location: { directory: process.cwd() } },
          { throwOnError: true },
        )
        await client.v2.session.prompt({
          sessionID: created.data.data.id,
          prompt: {
            text: "Write tests for every public function in this file.",
            files: [{ uri: pathToFileURL(path.resolve("packages/core/src", file)).href, name: file }],
          },
        })
        await client.v2.session.wait({ sessionID: created.data.data.id })
        console.log("done", file)
      }),
  )
} finally {
  server.close()
}
