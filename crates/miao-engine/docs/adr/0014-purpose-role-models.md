# ADR-14: Purpose-role model selection

Status: Proposed (A9's next step; only primary/fallback routing exists today).

## Context

A Session runs one model: the configured primary, with an optional fallback for
transport and quota failures. Every kind of work the engine issues -- the main
turn, history summarization, retrieval and recall lookups, and completion
verification -- therefore costs that model's price and latency, even when the
work only condenses text or answers a lookup. A9 asks for role routing, but the
semantics have to be fixed first: what a role binds to, what happens when a
role's model is unavailable or fails, and how evidence attributes cost when more
than one model has run.

## Decision

- **Three named roles, one binding each.** `summarize`, `retrieve`, and `verify`
  may each name a model. The main turn is not a role: it always uses the primary
  model.
- **A binding is a model id on the Session's own provider.** Credentials,
  endpoint, and placement belong to the Session; a role that needs another
  provider waits until per-role placement is designed.
- **Unbound means the primary.** A role without a binding, or whose binding the
  provider rejects, runs on the primary model. The engine never silently
  substitutes a different model id for an explicit binding, and it records the
  substitution it did make.
- **One escalation.** If a role's attempt fails -- provider error, or output the
  caller cannot use -- the engine retries that role once on the primary model
  and records the escalation in the evidence instead of failing the turn.
- **Cost attribution stays per attempt.** Every attempt already records model,
  tokens, and latency; an auxiliary attempt also records its role, so a report
  aggregates by role and by model without reconstructing provenance.
- **Quality gates the switch.** A role binding may become a default only once
  the frozen carriers show completion quality unchanged and total cost -- role
  attempts plus escalations -- lower than the primary-only baseline.

## Consequences

- The first implementation step is plumbing rather than policy: carry the
  bindings from config and the CLI into the runtime, and record role and model
  on auxiliary attempts. Auxiliary work moves onto roles only after that
  evidence exists.
- Small, fast models can be evaluated on summarization and retrieval first,
  where a wrong answer costs a retry rather than a wrong edit.
