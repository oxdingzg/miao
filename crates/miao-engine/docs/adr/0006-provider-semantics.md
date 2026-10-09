# ADR-06: Provider semantics

Status: Accepted (implemented by `src/provider.rs`, `src/routing.rs`,
`src/openai_chat.rs`, `src/openai_responses.rs`, `src/gemini.rs`,
`src/credential.rs`).

## Context

Providers differ in wire format, authentication, hosted tools, opaque reasoning
state, usage reporting, rate limits and retry behaviour. Converting everything
to a lowest-common-denominator message model silently drops information that a
fallback or a compaction later needs.

## Decision

- **Canonical messages preserve opaque state.** Provider-specific reasoning or
  signature fields are carried through fallback and compaction; they are never
  dropped to fit a single normal form.
- **Separate failure handling.** Transport retry, transport fallback and model
  fallback are distinct decisions sharing one attempt/time/cost budget. A model
  fallback first checks media, tool, context-window and reasoning-history
  compatibility and reworks the context when needed instead of blindly switching
  a model id.
- **Semantic output gates replay safety.** A metadata chunk is not visible
  output; replay safety is decided by published semantic output, hosted actions
  and tool dispatch.
- **Usage per attempt.** Each provider attempt records usage; a turn aggregates
  including failed retries. Cost comes from provider usage/price, not from
  character estimates.
- **Credential ownership.** Credentials are read from a single store; a refresh
  has one owner (a broker) so two runtimes never refresh a shared token
  concurrently. API-key access ships first; OAuth refresh through a single broker
  is the target.
- **Cache lineage is not session affinity.** A changed cache key does not by
  itself invalidate the whole prefix; cache behaviour is measured per provider
  before it is relied on.

## Consequences

- Fallback and compaction do not silently lose reasoning context.
- Cost and latency reporting reflect billed reality.
- Provider-specific behaviour is isolated in adapters behind one routing surface.
