# Acceptance record — COST-05 doctor report

Item: `COST-05`. Tree: `d13b75a3ee` plus this PR. Commands ran on the Linux build host
from `crates/miao-cli`.

## Criterion 1 — doctor reports version, protocol, routing, sandbox and dependencies

`miao doctor` reported the engine protocol/schema, the database path, size, Session count,
the config directory and the plugin count — it could not answer "which build is this, which
model will it actually use, is the sandbox on, and is a program it shells out to missing".

Now it prints, in one screen:

| line | meaning |
| --- | --- |
| `miao      <version>` | the running build |
| `engine    protocol N schema N` | wire protocol and ledger schema |
| `routes    N configured, primary <id>` | derived routes and the one a defaulted turn uses |
| `sandbox   enabled\|disabled` | the mode **in effect** (config `sandbox.mode`, with `MIAO_SANDBOX` winning), not what the platform could support |
| `deps      git ok, pdftotext ok, pdftoppm missing` | each program a feature shells out to, named individually so a support report says which one is missing |

| command | observed |
| --- | --- |
| `cd crates/miao-cli && cargo test --test doctor` | `1 passed; 0 failed` — a real `miao doctor` process with a fixture config (`sandbox.mode: "off"`) asserts the version line, a routing line, `sandbox   disabled`, and each of `git `, `pdftotext `, `pdftoppm ` |

## Criteria 2 and 3 — not accepted here

- **Log binding and a redacted diagnostic bundle.** `diagnostics.rs` appends failures to
  `log/miao.log` with structured fields, but no command exports a bundle, and nothing in
  this run shows a log correlated to a Session, a call and a cursor.
- **Capped tracing overhead.** No idle-CPU measurement is claimed; that needs the
  benchmark carrier.

Result: criterion 1 **accepted**; criteria 2 and 3 stay open on the item.
