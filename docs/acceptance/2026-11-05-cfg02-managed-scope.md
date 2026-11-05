# Acceptance record — CFG-02 the managed configuration scope

Item: `CFG-02`. Tree: `db0b250ae6` plus this record's commits. Commands ran on the Linux
build host from the crate directory named in each entry.

`2026-11-05-cfg02-unknown-keys.md` accepted the unknown-key half of this item and left one
criterion open: "configuration resolves across session, project, global and managed
scopes". This record closes it.

## The decision the item was waiting for

A managed layer is a *location* decision, so it is written down here rather than left to
each caller:

| platform | managed directory |
| --- | --- |
| Linux (and other Unix) | `/etc/miao` |
| macOS | `/Library/Application Support/miao` |
| Windows | `%ProgramData%\miao` |

Rules that keep it from being a surprise:

- it is a layer **only when the directory exists**, so a machine where nobody deployed one
  resolves exactly the stack it resolved before;
- it is the **lowest** priority layer: a user or project key always wins, which is what
  makes it safe for an administrator to set defaults;
- `MIAO_MANAGED_CONFIG_DIR` relocates it (tests and non-standard deployments), and an
  explicit `--config-dir` still returns that one directory and nothing else;
- `miao debug config` already prints every resolved key with the file that won it, so the
  managed layer is inspectable by the same command as the others.

## Criterion — four scopes resolve and are inspectable

| command | observed |
| --- | --- |
| `cd crates/miao-cli && cargo test --bin miao layer` | `4 passed; 0 failed` — `a_managed_layer_loads_first_and_only_when_it_exists` (managed first, global second, the project's `https://project.test/v1` still wins key for key, and an undeployed directory is not a layer), `a_project_layer_overrides_the_global_one`, `disabling_the_project_config_skips_its_layers`, `an_explicit_config_dir_stays_the_only_layer` |
| `cd crates/miao-engine && cargo test --lib config_scope::` | `10 passed; 0 failed` — directory discovery and per-directory file precedence are unchanged |

The two existing layer tests now pass `None` for the managed directory explicitly, so a
developer machine that happens to carry `/etc/miao` cannot make them flaky.

`docs/guide.en.md` and `docs/guide.zh.md` now state the full precedence chain and both
override variables instead of naming only project > global.

Result: **accepted**, with the caveat that no acceptance run exercises a real
administrator-deployed file on macOS or Windows — the platform paths are constants and the
Linux run covers the loading rule.
