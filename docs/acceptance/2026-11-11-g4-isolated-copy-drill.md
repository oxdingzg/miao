# Acceptance record — G4: isolated-copy migration, fault-injection and reverse-recovery drill

Item: REL-04 gate G4 (`specs/rust-retirement-gates.md`): migration, fault
injection, duplicate execution and reverse recovery on an isolated copy, with
backup identity and integrity verified — never against a real user database.
Tree: `0df016375c` (plus the G1/G2/G3 records already on main). Drill executed
2026-11-11 00:08 on the macOS build host, binary = the release build of the
`step_finish` fix commit (4f9bd750d7, `miao db backup` included).

## Isolated source

A benchmark-cell ledger (created by this program's own G7 runs — not user
data): 247 engine events, 1 session, snapshotted with SQLite `.backup` for a
consistent single file. SHA-256 `7133f0019e9c82281488a3b293be3f5f353898acee73
08be8f970d124eebc540`, 913,408 bytes.

## Drill transcript (all paths under one temp directory on the build host)

| step | action | result |
| --- | --- | --- |
| 1 | snapshot + checksum | `7133f001…bc540`, 913,408 bytes |
| 2 | `miao db backup --db ledger.db --to backup.db` | success — `schema 25`, `integrity_check ok`, blobs copied; backup SHA `84edf18bb7443281976f87cf8ec833f925d489436d472384320450d9af2e2b7e` |
| 3 | duplicate execution: re-backup the backup | success, `integrity_check ok` |
| 4a | fault injection: truncate to 50% → re-backup | **explicit failure**, exit 1: `copy truncated.db: database disk image is malformed` |
| 4b | fault injection: byte flip at offset 5,000 (free page) → re-backup | backup succeeded — the flip landed outside any allocated page, see the honest negative below |
| 4c | fault injection: byte flip at offset 400,000 (content pages) → re-backup | **explicit failure**, exit 1: `the copy failed integrity_check: row 8 missing from index engine_event_selection` |
| 5 | reverse recovery: restore `backup.db` over the working name | restored SHA identical to the backup (`84edf18b…`); reopens, backs up cleanly again, and all 247 events are present (`select count(*) from engine_event`) |

## API-level fault paths on the same tree

`crates/miao-engine/tests/migration.rs` (re-run for the G1 record, **5 passed /
0 failed**) covers the store-level faults the drill cannot inject: migration
freeze/reopen, abort fenced to pre-cutover, refusal of pending inputs with
retry-identity upgrade, and a downgraded store finishing the migration
idempotently on reopen — the duplicate-migration-execution case.

## Honest negative

The backup's integrity net is `VACUUM INTO` (reads every allocated page) plus
a read-back `PRAGMA integrity_check`. A byte flip inside a **free page**
(offset 5,000 of this ledger) is not detected: no allocated content reads that
region, and the ledger's own data remains intact and recoverable. The record
states this rather than claiming byte-level corruption coverage; an operator
who needs media-level assurance keeps the `.sha256` alongside the backup and
compares before trusting it (both hashes appear in this transcript).

## What this record does not claim

The source was a bench-cell ledger, not a years-old upgraded-in-place user
database; the multi-generation upgrade ladder is `tests/migration.rs`'s
coverage plus the 2026-11-04 record. Windows restore behaviour is not
exercised here (POSIX build host).
