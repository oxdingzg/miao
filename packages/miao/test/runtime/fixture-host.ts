import { RuntimeHost } from "../../src/runtime/host"
import { WindowLifecycle } from "../../src/runtime/lifecycle"
import { DatabaseFile } from "@miao/core/database/file"

WindowLifecycle.install()
const runtime = await RuntimeHost.start(DatabaseFile.path())
console.log(JSON.stringify(runtime.record))
await runtime.closed
await WindowLifecycle.close()
process.exit()
