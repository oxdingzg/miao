import { SessionModelRoute } from "@miao/schema/session-model-route"
import type { Provider } from "@miao/schema/view-models"

/** Display host routes without treating transport names as product providers. */
export function nativeModelLabel(
  route: {
    model: { providerID: string; id: string }
    productModel?: { providerID: string; id: string }
    protocol: string
    wireModel: string
  },
  providers: readonly Provider[],
) {
  const id = route.productModel
    ? `${route.productModel.providerID}/${route.productModel.id}`
    : route.model.providerID === SessionModelRoute.ProviderID
      ? route.model.id
      : undefined
  const provider = providers.find((provider) => id?.startsWith(`${provider.id}/`))
  const model = provider && id ? provider.models[id.slice(provider.id.length + 1)] : undefined
  return {
    provider: provider?.name ?? route.productModel?.providerID ?? route.protocol,
    providerID: provider?.id ?? route.productModel?.providerID,
    model: model?.name ?? route.wireModel,
    modelID: route.productModel?.id ?? (provider && id ? id.slice(provider.id.length + 1) : undefined),
  }
}
