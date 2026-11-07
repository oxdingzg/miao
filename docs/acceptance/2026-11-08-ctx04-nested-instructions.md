# Acceptance record — CTX-04 nested instructions from file reads

Item: `CTX-04`. Tree: `main` including #2684. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-engine/` at that tree.

## The criteria this record accepts

**Directory instructions are identified after a successful file read, admitted
durably at the next safe provider turn boundary, and recorded with source and
priority without duplicate injection or cross-project leaks.**

- *Identification and the boundary*: only successful, durably settled file
  reads activate nested instructions
  (`crates/miao-engine/src/context.rs`); the activation lands at the next
  provider turn boundary, exactly once —
  `successful_reads_activate_scoped_instructions_at_the_next_boundary_once`
  walks a real workspace with nested `AGENTS.md` files and asserts the
  instruction enters the request at the following boundary, not twice.
- *Durability and isolation*: `observations_survive_reopen_and_never_leak_to_another_session`
  reopens the store and confirms the discovered instructions are still applied
  to their session and no other session inherits them.
- *Source, priority, policy*: `project_instructions_are_scoped_bounded_and_policy_checked`
  (scoping, bounds, permission policy),
  `explicit_sources_preserve_order_policy_and_fingerprints` (source order and
  fingerprint recording), and
  `runtime_reloads_instructions_at_boundaries_without_session_id_in_cache_prefix`
  (boundary reload keeps the cache prefix stable) pin the rest.

## Suites

| what | command | observed |
| --- | --- | --- |
| the read-activated boundary and durability | `cargo test --test context_read` | `12 passed; 0 failed`, 2.6 s |
| scoping, policy, fingerprints, epochs | `cargo test --test context` | `12 passed; 0 failed`, 1.1 s |

## What this record does not claim

- Windows unexercised, as before.
