/** Client rendering shapes preserve unknown clocks without changing V1 archive schemas. */
type RenderState<State> = State extends { time: infer Time }
  ? Omit<State, "time"> & { time: { [Key in keyof Time]: Time[Key] | null } }
  : State

export type ToolPart = Omit<import("./view-models").ToolPart, "state"> & {
  state: RenderState<import("./view-models").ToolPart["state"]>
}

export type ReasoningPart = Omit<import("./view-models").ReasoningPart, "time"> & {
  time?: { start: number | null; end?: number | null }
}

export type Part = Exclude<import("./view-models").Part, { type: "tool" | "reasoning" }> | ToolPart | ReasoningPart

export type PartType = Part
