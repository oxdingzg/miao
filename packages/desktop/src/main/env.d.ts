interface ImportMetaEnv {
  readonly MIAO_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:miao-server" {
  export namespace Server {
    export const listen: typeof import("../../../miao/dist/types/src/node").Server.listen
    export type Listener = import("../../../miao/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../miao/dist/types/src/node").Config.get
    export type Info = import("../../../miao/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../miao/dist/types/src/node").bootstrap
}
