import { Effect, Layer } from "effect"
import { LocationServiceMap } from "../location-service-map"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  let allReplacements = replacements

  // Only build the location service map if it's actually needed
  if (LayerNode.hasUnbound(root, LocationServiceMap.node) && !hasReplacement(replacements, LocationServiceMap.node)) {
    // The location service graph pulls in nearly all of core. Load it only when a
    // root actually needs it, so processes such as the TUI thread, whose roots never
    // reach LocationServiceMap, do not pay its module evaluation cost at startup.
    // buildLocationServiceMap still returns its shared layer instance, which the
    // MemoMap deduplicates through the unwrap.
    const locationMap = Layer.unwrap(
      Effect.promise(async () => {
        const { buildLocationServiceMap } = await import("../location-services")
        return buildLocationServiceMap(replacements)
      }),
    )
    const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
    allReplacements = replacements.concat([[LocationServiceMap.node, locationMapNode]])
  }

  return LayerNode.compile(root, allReplacements)
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"
