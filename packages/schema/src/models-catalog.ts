export * as ModelsCatalog from "./models-catalog"

import { define, inventory } from "./event"

const Refreshed = define({
  type: "models-catalog.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }
