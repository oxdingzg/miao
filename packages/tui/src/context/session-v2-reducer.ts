// Preserve the TUI entrypoint while sharing its pure projection with native
// server history reads. Browser application reducers remain separate.
import { SessionTranscript } from "@miao/core/session/transcript"

export type TuiV2SessionReduction = SessionTranscript.Reduction
export const createTuiV2SessionReducer = SessionTranscript.create
