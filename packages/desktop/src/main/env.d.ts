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
}
