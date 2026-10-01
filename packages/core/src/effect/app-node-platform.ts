import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { LLMClient, RequestExecutor, WebSocketPool } from "@miao/llm/route"
import { FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient],
})
// The pool is the client's own state (one socket per session), so it lives inside
// the client layer rather than as a separately addressable node.
export const llmClient = makeGlobalNode({
  service: LLMClient.Service,
  layer: LLMClient.layer.pipe(Layer.provide(WebSocketPool.layer)),
  deps: [requestExecutor],
})

export * as LayerNodePlatform from "./app-node-platform"
