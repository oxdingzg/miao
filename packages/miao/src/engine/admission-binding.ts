import { SessionAdmission } from "@miao/core/session/admission"
import type { LayerNode } from "@miao/core/effect/layer-node"
import { AdmissionEngine } from "./admission"

/**
 * S2: every Session admits through the engine inbox.
 *
 * These replacements identify the location service map: two compositions that
 * pass different lists build two graphs for the same directory, and a service
 * created in one graph (a pending permission, say) is invisible to the other.
 * The CLI runtime and the route assembly therefore share this one list, so the
 * process resolves a directory exactly once.
 */
export const admissionReplacements: LayerNode.Replacements = [[SessionAdmission.node, AdmissionEngine.node]]
