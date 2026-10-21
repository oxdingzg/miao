# Native transfer acceptance run — 2026-10-21

First real-binary end-to-end acceptance of the TS→native transfer path (gap 4
of the enablement gap list), run against main @ `d5dc81fd81` with a release
`miao-engine` built from that commit (sha256 `07c6f609…`, protocol 2 /
schema 21) and the source runtime from the same tree. The isolated store was
seeded with a `zhipuai-coding-plan` credential; the model was
`glm-5.3-flash` over the bigmodel gateway (openai-chat).

## Verified

1. **Migration pipeline (offline transfer bundle).** `miao session migrate`
   completed: durable bundle export → native staging → activation → placement
   rewrite. The product placement row flipped to
   `engine=rust, native_storage=<storage>/<location-hash>.db, location=<workspace>`,
   and the native store received the full imported history (user prompt, tool
   call + result, assistant answer — 4 `engine_message` rows).
2. **Native-born sessions.** With `MIAO_ENGINE_STORAGE` pointing at a storage
   root, a new session is born on the engine, drains its first prompt
   engine-owned, and records its durable admission (`engine_input`) and
   transcript in the per-location native DB.
3. **Per-location storage derivation.** New native placement derives
   `<root>/sha256(JSON(location)).db` deterministically; the same location
   always maps to the same per-location DB.
4. **Placement binding immutability.** With the engine environment removed
   after migration, the rust-placed session keeps its placement row and its
   native history stays intact; no TS adoption or data mixing occurred.

## Gaps found (fixes included here unless noted)

- **R-1 (fixed): `session migrate` / `migrate-back` crashed at layer
  compile.** The commands' node graphs include `Snapshot.node`, which depends
  on the unbound `Location.node`; no CLI path ever bound it. Both commands now
  stage their work behind a first pass that reads the session, then provide a
  builder with `Location.boundNode(session.location)`.
- **R-2 (fixed): the migration staging engine had no model routes.** The TS
  projection stamps `variant: "default"` on model bindings; without a
  registered route variant the staging engine rejects every transfer with
  "model variant is not registered by the host". `nativeEngineOptions` now
  honors `MIAO_ENGINE_MODEL_ROUTES` (same precedence as the other
  `MIAO_ENGINE_*` overrides), so an operator can hand the staging child the
  same routes file the product composes.
- **R-3 (open): `run --continue` against a native session fails.** After one
  promoted prompt, continuing a native session (migrated or native-born) via
  the CLI fails — an input-admission conflict on a fresh prompt, or "Model is
  not in the native host route catalog" when another session's admission
  shares the per-location engine. Continuation over the shared per-location
  engine needs a dedicated design pass (input-id derivation and per-session
  route binding both look involved). The TUI/server owner path is untested
  here and may behave differently.
- **R-4 (observation): the cross-process write lock is flock-based** and a
  stale `*.engine-write-lock` file does not block restarts — consistent with
  the crash-recovery expectations.

## Scenario status

| Scenario | Status |
| --- | --- |
| a. TS→native offline transfer | pipeline verified; continuation blocked by R-3 |
| b. rollback / storage isolation | binding immutability + isolation verified; full rollback drill blocked by R-3 |
| c. crash recovery | blocked by R-3 (needs a drivable continuation to prove re-adoption) |

The scenario driver (isolated store seeding, credential injection, migration,
placement assertions) lives in the branch as
`script/acceptance-transfer.sh`-style steps recorded in the PR; the raw
artifact directory is `/tmp/miao-acc` (not committed).
