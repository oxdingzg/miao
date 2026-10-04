export * as RuntimeControlAgent from "./control-agent"

import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { OpenCode } from "@miao/client"
import { DeviceGrants } from "@miao/remote-control/grants"
import { ControlAgent } from "@miao/remote-control/agent"
import { RuntimeControlMethods } from "./control-methods"
import { AppRuntime } from "../effect/app-runtime"
import { ServerAuth } from "../server/auth"

const Configuration = Schema.Struct({
  hubURL: Schema.String,
  hostToken: Schema.String.check(Schema.isMinLength(32)),
  grantFile: Schema.String.check(Schema.isMinLength(1)),
  allowLoopbackHTTP: Schema.optional(Schema.Boolean),
})

/** Owner-only configuration, never received through the remote RPC channel. */
export async function start(input: { url: string; credential: string; runtimeID: string }) {
  const filename = process.env.MIAO_REMOTE_CONTROL_CONFIG
  if (!filename) return undefined
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const configuration = await (async () => {
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        stat.size > 16384 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error("Remote Control configuration must be a private owner-readable file")
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Configuration)), {
        onExcessProperty: "error",
      })(await file.readFile("utf8"))
      if (Option.isNone(decoded)) throw new Error("Invalid Remote Control configuration")
      return decoded.value
    } finally {
      await file.close()
    }
  })()
  const grants = await DeviceGrants.load(path.resolve(path.dirname(filename), configuration.grantFile))
  const client = OpenCode.make({
    baseUrl: input.url,
    headers: ServerAuth.headers({ username: "miao", password: input.credential }),
  })
  return ControlAgent.connect({
    hubURL: configuration.hubURL,
    hostToken: configuration.hostToken,
    allowLoopbackHTTP: configuration.allowLoopbackHTTP,
    runtimeID: input.runtimeID,
    grants,
    methods: RuntimeControlMethods.make({ client, run: (effect) => AppRuntime.runPromise(effect) }),
    projectForSession: async (sessionID) => {
      const session = await client.sessions.get({ sessionID }).catch(() => undefined)
      return session?.projectID
    },
  })
}
