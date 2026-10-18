# 0017. Session-owned agent manifests

Status: accepted (design), implementation pending

## Context

The product's `session.switchAgent` selects which agent handles a Session's
subsequent provider turns. An agent carries instructions, a tool surface, a
permission policy and sometimes a model. The engine has none of that: its
per-turn descriptor is the constant
`{"name":"native-runtime","semantics":"native-runtime-v1","collaborationMode":...}`
(`src/runtime.rs`), its system prompt is the base prompt plus workspace
instructions plus a collaboration-mode block, its tool registry and policy come
from the operator's `--policy`, and its model binding is the Session-owned
selection from `src/session_model.rs`.

So a native Session can only ever run as `native-runtime`. That is the gap this
decision closes: the engine must be able to run a Session *as a named agent*
whose definition the host owns.

## Decision

The host resolves the agent and sends the engine a **manifest**, never an agent
name to look up. The engine owns application, not resolution: it has no agent
catalog, no config merge and no plugin discovery, which is the same boundary it
already keeps for commands, skills and MCP servers.

`Command::SelectAgent { session_id, agent }` where `agent` is a bounded,
`deny_unknown_fields` manifest:

| field | type | meaning |
| --- | --- | --- |
| `name` | string (required, ≤128) | identity recorded in the profile and used in the transcript |
| `semantics` | string (optional) | the host's manifest revision marker, hashed into the profile |
| `instructions` | string (optional, ≤64 KiB) | appended to the base system prompt as one bounded block |
| `tools` | `{allow?: string[], deny?: string[]}` | intersected with the registered tool names |
| `permissions` | `Rule[]` | operator-shaped rules overlaid on the configured policy |
| `model` | `Binding` (optional) | the agent's pinned model, applied only when the Session has no explicit selection |

Durability and timing:

- The command appends `session.agent.selected` with the manifest and its content
  hash. The Session's current agent is the newest such event, exactly as
  `session.model.selected` derives the current binding; no new table is needed.
- Application is at the **provider-turn boundary**, like model selection: a turn
  already in flight finishes under the agent it started with.
- The turn's provider scope records the agent descriptor
  `{"name", "semantics", "agentHash", "collaborationMode"}`, so the recorded
  profile identifies which agent produced a turn.
- The transcript projects `session.agent.selected` as the product's
  `AgentSwitched` event.

## Invariants

1. **One owner per concern.** Resolution stays with the host; application stays
   with the engine. The engine never reads product agent configuration.
2. **Approvals are bound to the effective policy.** The agent's `permissions`
   overlay participates in `policy.revision()`; an approval carries that
   revision (`src/runtime.rs` compares it before accepting a response), so a
   pending approval taken under one agent can never be replayed under another.
3. **Operator intent outranks an agent's defaults.** An explicit Session model
   selection wins over the agent's pinned `model`; the agent's model applies only
   while the Session has no selection.
4. **The tool surface only shrinks.** `allow`/`deny` intersect the registered
   tools; they never add a capability the policy would deny, because permission
   evaluation still runs for every call. An unknown name in `allow` is a refusal
   at admission, not a silent no-op: a host that typos an agent's tool list must
   hear about it.
5. **Collaboration mode stays single-sourced.** When the agent carries a mode
   the engine records it through the existing `set_mode` path, so plan-mode
   denial and the `<collaboration-mode>` block keep exactly one implementation.
6. **Bounded and inert.** Every field is length-bounded like the other wire
   inputs; the manifest is recorded as data and is never evaluated as a
   template.

## Rejected alternatives

- **An agent catalog inside the engine.** It would duplicate product config
  merge, plugin discovery and per-Location resolution, and would put product
  semantics behind the engine's version cadence.
- **Reusing `Command::Mode` as the whole mechanism.** Mode is the collaboration
  axis (build/plan) and stays that; an agent is a superset that may also carry
  instructions, tools, permissions and a model.
- **Per-turn agent arguments on `admit`.** The product's switch is a Session
  state, not a per-message option; putting it on the input would let two queued
  prompts disagree about the agent that answers them.

## Implementation plan

1. Protocol: `SelectAgent` + the manifest schema with bounds; `session.agent.selected`
   event, and the derived "current agent" read.
2. Runtime: apply instructions (one block appended to the system prompt), tool
   intersection, permission overlay with a revision that includes the agent hash,
   optional model binding, and the agent descriptor in the provider scope.
3. Facade: `session.switchAgent` resolves the product agent, builds the manifest
   and calls the command; the product projection maps `session.agent.selected`
   to `AgentSwitched`.
4. Tests: engine (revision changes with the overlay, tools shrink, instructions
   appear in the outgoing request, mode through the existing path, pinned model
   loses to an explicit selection) and an HTTP acceptance test against a real
   binary.
