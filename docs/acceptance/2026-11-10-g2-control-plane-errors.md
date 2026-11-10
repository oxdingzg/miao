# Acceptance record — G2: control-plane inventory and explicit errors

Item: REL-04 gate G2 (`specs/rust-retirement-gates.md`), the two named gaps from
`docs/acceptance/2026-11-05-rel04-completion-gate.md`: the frozen HTTP/route
group inventory mapped to Rust owners, and a record showing unsupported
features error explicitly instead of silently degrading. Tree: `77d9026002`
plus this record's test commit; verification ran 2026-11-10 on the macOS build
host.

## 1. The HTTP plane's frozen inventory

`crates/miao-engine/src/http.rs` mounts exactly five routes (`http.rs:278`–
`282`), each with a Rust owner:

| route | method | owner |
| --- | --- | --- |
| `/rpc` | POST | `rpc` handler → `Host::dispatch` (`host.rs:41`) over the typed `Command` enum — **110 commands**, each arm naming the runtime/store method that serves it |
| `/events` | GET | SSE replay off the session's durable event stream |
| `/version` | GET | `version` (`http.rs:387`) — answers `PROTOCOL_VERSION` (`engine-http-0`) |
| `/api/health` | GET | `health` handler |
| `/lease` | POST | attach-lease renewal feeding the idle shutdown loop |

The plane is loopback-only, bearer-token gated, and CORS-restricted to the
shell scheme plus loopback web origins (`http.rs:136`–`221`). CLI commands are
inventoried separately and already accepted
(`docs/acceptance/2026-11-04-cli-entry-point.md`,
`2026-11-08-rus04-cli-entrypoints.md`).

## 2. Unsupported features error explicitly — new tests

`the_rpc_plane_names_every_rejection_instead_of_degrading` (new, in
`http.rs`'s test module, against the real `rpc` handler with a real `Runtime`)
walks four rejection paths and one supported path:

| request | status | named code |
| --- | --- | --- |
| no bearer token | 401 | `unauthorized` |
| unknown protocol revision (`engine-http-999`) | 400 | `unsupported_protocol` |
| body without a typed command | 400 | `invalid_request` |
| a feature the plane does not know (`time_travel`) | 400 | `invalid_request` |
| `/version` from a supported client | 200 | tagged `engine-http-0` |

Results on this tree: http module **8 passed / 0 failed** (the four CORS
tests plus these four rejection paths and the version tag).

## What this record does not claim

The 110-command RPC surface is inventoried as a count with its single dispatch
owner; the per-command behaviour matrix is G3's client-facing records, and the
`serve` command's startup behaviour was accepted in RUS-04's records.
