# Restart-recovery drill — 2026-10-23

Real-client acceptance for §2.4 (crash-recovery idempotency on the RS
primitives): a genuine SIGKILL mid-tool, a fresh client and engine process
afterwards, the unknown outcome surfaced through the product recovery API,
and one durable abandon decision. No mocks, no scripted provider.

## Setup

- Client: `miao-dev` TUI (local channel) in a scratch workspace
  `/tmp/miao-restart-drill`, native engine enabled (`engine-on.sh`, engine
  0.2.25, `deepseek/deepseek-v4.1-flash`).
- Prompt: "Use the bash tool to run exactly: sleep 90".
- Session: `ses_gfe5e96ccf421ffeWjTqsvBD8S` (product store
  `miao-local.db`; engine store
  `~/.local/share/miao-engine/storage/5e8a26c3….db`).

## Crash

With the tool in flight — `miao-engine __process-guardian` pid 64716 running
`bash -c sleep 90` (child 64717) — the client (pid 64257), the engine serve
(pid 64680), the guardian and the `sleep` were all SIGKILLed. No cleanup
handlers ran.

## Durable aftermath (verified in the engine store)

```sql
sqlite> SELECT name, state FROM engine_tool ORDER BY rowid DESC LIMIT 1;
bash|unknown
```

The tool outcome survived the crash as `unknown`; nothing re-ran.

## Recovery through the real client surface

About an hour later, a fresh `miao-dev serve --port 4649` (new process, no
prior state) served the same workspace, and the same protocol the TUI's
recovery dialog uses was driven against it:

```
GET /api/session/ses_gfe5e96ccf421ffeWjTqsvBD8S/recovery
→ {"calls":[{"callID":"5e11a491-6347-47d8-85e3-0750c2de7248/call_00_espw8n8e8g1pvydd4dmrgin7",
    "runID":"5e11a491-…","tool":"bash","outcome":"unknown","resolution":null}],
   "hasMore":false}

POST /api/session/ses_gfe5e96ccf421ffeWjTqsvBD8S/recovery
  {"callID":"5e11a491-…/call_00_espw8n8e8g1pvydd4dmrgin7",
   "operationID":"E0B15B30-0EB5-4672-AD8C-8CD036B12FCA","decision":"abandon"}
→ {"decision":"abandon","inputID":"recovery_E0B15B30-0EB5-4672-AD8C-8CD036B12FCA",
   "admittedSeq":21,"outcome":"unknown"}
```

A follow-up GET shows the resolution attached to the call, and the engine
store keeps `bash|unknown` — the unknown outcome is never rewritten, the
`sleep 90` never re-executed (verified: no `sleep 90` process before or after
the decision). Exactly the ADR-16 contract: one durable decision, preserved
unknown, no automatic repetition.

## Verdict

§2.4 restart acceptance is recorded. What remains from the §2.4 line is
nothing code-side; the row in the roadmap closes with this drill.
