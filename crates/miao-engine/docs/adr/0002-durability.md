# ADR-02: Durability and side-effect contract

Status: Accepted (implemented by `src/store.rs`, `src/runtime.rs`).

## Context

A prompt, a model turn, and a tool call each produce externally visible effects
that a crash can interrupt at any point. The engine needs one authority for
those effects and a recovery rule for every interruption point, without claiming
exactly-once execution of arbitrary external operations.

## Decision

- **One durable authority.** SQLite in WAL mode with `synchronous=FULL` manages
  `session_input`, canonical events, key projections and tool
  dispatch/settlement in one transaction boundary. JSONL export is derived and
  never a second writer. Storage carries an application id and schema version;
  an unknown or newer schema is refused.
- **Admission before acknowledgement.** A prompt is committed as a durable inbox
  row before it is acknowledged. Reusing an input id is an exact retry only when
  session, body and delivery mode all match; otherwise it fails.
- **Inbox is not visibility.** Admission does not mean the prompt is a visible
  user message or has executed. Promotion into the transcript happens at a safe
  provider-turn boundary.
- **Tool lifecycle.** A tool moves `planned` → dispatch intent committed →
  externally running → settlement committed. Intent and settlement are durable;
  the running interval is not.
- **Crash reconciliation.** A dispatch without settlement is *unknown* on
  recovery. The engine records an explicit interrupted/unknown result and never
  automatically re-runs a shell or network write. Provider work is not resumed
  automatically.
- **Retry ceiling.** Automatic retry is allowed only while it is provable that no
  semantic output or side effect occurred. No external operation is advertised
  as exactly-once.
- **Scoped rollback.** Fork, compaction and checkpoint declare which projection,
  event stream or filesystem slice they read and rewrite. Rolling back a
  checkpoint file is not the same as rolling back a conversation, and neither
  reverts external network effects or concurrent user edits.

## Consequences

- Every externally visible effect has a defined recovery answer.
- Clients see committed state plus an explicit unknown/interrupted marker rather
  than a silent gap.
- The engine admits weaker guarantees for external side effects instead of
  pretending they are transactional.
