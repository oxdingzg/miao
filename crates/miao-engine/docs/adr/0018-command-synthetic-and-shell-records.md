# 0018. Command, synthetic and shell records

Status: accepted (design), implementation pending

## Context

The product admits three invocations that are not plain prompts, and a native
Session currently refuses all three:

- `session.command` admits a prompt that carries a **command reference**
  (`{name, arguments}`); the runner expands the command's template at turn time,
  and the transcript renders a command chip instead of a bare user message.
- `session.skill` injects the skill body as a **synthetic** message: the
  transcript shows it as injected context, not as something the operator typed.
- `session.shell` does not admit a prompt at all. The host executes the command
  and records `Shell.Started`/`Shell.Ended`; the transcript shows a shell block
  with its output.

The engine models inputs as text plus attachments and projects them as operator
messages, so none of the three survives the crossing: a faithful mapping needs
three record kinds, not three adapters that flatten them into user text. This
decision defines those kinds.

## Decision

Three durable records, one for each invocation, all owned by the existing event
ledger and projected by the host's native event bridge.

### 1. Command references (`session.command`)

The admission carries the command identity next to the prompt the host already
resolved:

```
Input {
  prompt: string,                       // the expanded template, what the model reads
  command?: { name: string, arguments?: string, source?: string },
}
```

The expansion stays with the host — command templates come from product config and
plugins, and the engine has no command catalog. The reference is recorded with the
admitted input (`input.admitted.command`) and projected as the product's command
message, so the chip survives while the model receives exactly the expanded text.

### 2. Synthetic messages (`session.skill`)

`Command::Inject { session_id, input_id?, text, source }` records
`message.synthetic` with `{source, text}` and no promoted operator input: there is
no inbox row, because nothing is waiting for a turn to consume it. The message is
part of the Session's history from that point on (projected as an injected
context block), and the host decides whether to resume the Session afterwards —
the engine never starts a provider turn on its own, which is the rule it already
keeps for wakes with no eligible input.

### 3. Shell records (`session.shell`)

The **engine executes**, the host asks:

`Command::Shell { session_id, call_id?, command, timeout_ms? }` runs the command
through the same process layer the model's `run_command` tool uses (one execution
owner, one sandbox, one policy evaluation, one cancellation and process-group
reaping path), then records `shell.started` and `shell.ended` with
`{call_id, command, exit_code, output, truncated, duration_ms}`.

Invariants for this record:

- Execution is a **user-initiated call**, so it is evaluated against the same
  policy as a tool call but is attributed as an operator action in the transcript
  (`shell.started.origin = "operator"`), never as a model tool call: the model
  must not be able to claim it asked for it.
- The command's output enters the history under the same bounded-output rules as
  tool results (byte cap, truncation marker, recall handle for the elided tail),
  and is included in the next turn's history rather than triggering a turn.
- Plan-mode and other denials that apply to a tool call apply here too, and are
  reported as a refusal rather than an executed-then-denied record.
- The call identity is host-supplied when present (so a retried request
  reconciles), and engine-generated otherwise; a retry with the same identity and
  a different command is a conflict, matching every other admission.

## Rejected alternatives

- **Flattening all three into user text.** Cheapest, but it misattributes
  injected context and operator shell output to the operator's own words,
  destroys the command chip, and makes the transcript a lossy record of what
  actually happened.
- **Host-side shell execution.** Two execution owners (host and engine) means two
  sandboxes, two cancellation paths and two policy evaluations for the same
  Session; the engine already owns process groups, PTYs and their reaping.
- **Synthetic messages as ordinary inputs with `delivery: queue`.** They would
  enter the inbox and be promoted by the runner, giving them a turn and a
  promotion order they do not have; injection is a history fact, not a queued
  intent.
- **A command-template catalog in the engine.** Same reason as 0017: resolution
  belongs to the host.

## Implementation plan

1. Protocol: `Input.command`, `Inject`, `Shell`, plus the `message.synthetic`,
   `shell.started` and `shell.ended` event shapes and their projections.
2. Store: record helpers with the same bounds as `admit`/`record`, history
   inclusion rules for synthetic and shell rows, and retry reconciliation.
3. Runtime: shell execution on the existing process layer with policy
   evaluation and bounded output; no implicit turn start.
4. Facade: the three handlers stop refusing and call these commands; the native
   event bridge projects the new records onto the product's command, synthetic
   and shell events.
5. Tests: engine (retry identity, output bounding, plan-mode refusal, history
   inclusion without a turn) and an HTTP acceptance test per invocation.
