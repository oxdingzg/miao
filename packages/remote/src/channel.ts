// The seam between the Router and one IM network. A channel knows how to reach
// people; the Router knows what to say. Everything network-specific (reply
// tokens, typing tickets, rate limits) stays behind this interface.

export type Capabilities = {
  /** Inline buttons for approvals. WeChat has none, so approvals use short reply codes. */
  readonly buttons: boolean
  /** Whether the channel can message a person who has not just written to it. */
  readonly push: boolean
  /** Longest text the channel delivers as one message; longer text is split by the channel. */
  readonly maxLength: number
  /** Proactive messages allowed per local day. Omitted means unlimited. */
  readonly pushBudgetPerDay?: number
  /** How long after an inbound message replies are accepted. Omitted means always. */
  readonly replyWindowMs?: number
  /** How many messages one inbound message may be answered with. Omitted means unlimited. */
  readonly repliesPerInbound?: number
}

export type Inbound = {
  readonly user: string
  readonly text: string
  /** Opaque per-message context the channel needs to answer this exact message. */
  readonly reply?: unknown
}

export type SendResult = {
  readonly ok: boolean
  /** Messages the network accepted, counting each split chunk. */
  readonly sent: number
  readonly error?: string
}

export interface Channel {
  readonly id: string
  readonly capabilities: Capabilities
  /** Begins receiving. Resolves once receiving has started; delivery continues in the background. */
  readonly start: (onMessage: (message: Inbound) => Promise<void>) => Promise<void>
  readonly stop: () => Promise<void>
  readonly send: (user: string, text: string, reply?: unknown) => Promise<SendResult>
  readonly typing: (user: string, on: boolean) => Promise<void>
}
