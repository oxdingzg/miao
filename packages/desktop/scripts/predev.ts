import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.MIAO_CHANNEL ?? "dev"}`

await $`cd ../miao && bun script/build-node.ts`
await downloadCliToResources()
