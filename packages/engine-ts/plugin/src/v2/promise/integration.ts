import type { IntegrationDraft, IntegrationMethodRegistration } from "../effect/integration.js"
import type { CredentialValue } from "@miao/schema/view-models"
import type { Hooks } from "./registration.js"

export type { IntegrationDraft, IntegrationMethodRegistration }

export interface IntegrationHooks extends Hooks<{ transform: IntegrationDraft }> {
  readonly connection: {
    readonly active: (integrationID: string) => Promise<import("@miao/schema/view-models").ConnectionInfo | undefined>
    readonly resolve: (
      connection: import("@miao/schema/view-models").ConnectionInfo,
    ) => Promise<CredentialValue | undefined>
  }
}
