import { createSimpleContext } from "@miao/ui/context"
import { type Accessor, createMemo } from "solid-js"
import { type ServerSDK, useServerSDK } from "./server-sdk"

export type DirectorySDK = ReturnType<ServerSDK["ensureDirSdkContext"]>

// The protocol event union is a wide structural type, so the context type is spelled out here
// instead of being inferred: inference would ask the compiler to serialize the whole union.
export const { use: useSDK, provider: SDKProvider } = createSimpleContext<
  Accessor<DirectorySDK>,
  { directory: string | Accessor<string> }
>({
  name: "SDK",
  // Resolves the directory-scoped SDK reactively from the (possibly changing) server.
  init: (props: { directory: string | Accessor<string> }) => {
    const serverSDK = useServerSDK()
    return createMemo(() => {
      const directory = typeof props.directory === "function" ? props.directory() : props.directory
      return serverSDK().ensureDirSdkContext(directory)
    })
  },
})
