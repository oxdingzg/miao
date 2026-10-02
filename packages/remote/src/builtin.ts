import type { Connector } from "./connector"
import { qq } from "./connectors/qq"
import { wechat } from "./connectors/wechat"

/** Connectors that ship with miao, in the order interfaces list them. */
export const builtinConnectors: ReadonlyArray<Connector> = [wechat, qq]
