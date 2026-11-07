/**
 * Runs the Runtime access protocol against one request on stdin, the way the
 * retired `miao runtime access` command did, so `host.test.ts` can keep
 * asserting it never leaks the host token.
 */
import { DatabaseFile } from "@miao/core/database/file"
import { run } from "../../src/runtime/access"

console.log(JSON.stringify(await run(DatabaseFile.path())))
