# config-golden

Shared golden samples for S5 step 2 ("derive the product config in the
engine"). Each `policy-*` case is one config directory plus the environment
the host forwards; the expected policy is what the engine must derive. The
engine test (`crates/miao-engine/tests/config_golden.rs`) and the TypeScript
suite (`packages/miao/test/engine/config-golden.test.ts`) read these same
directories, so the two config implementations stay pinned to one set of
samples: two implementations, one set of inputs and outputs.

- `global/` — the config documents, in `miao.json` / `miao.jsonc` /
  `opencode.json` / `opencode.jsonc` precedence within the directory.
- `env.json` — `{"MIAO_SANDBOX": "1" | "0" | null}`; `null` means unset.
- `expected-policy.json` — the full derived `permission::Config`; the
  TypeScript side asserts its `sandbox` switch against the same case.

A `policy-*` case may instead carry `sources.json` — the ordered source plan
the host forwards as `--config-sources`: `[{"dir": …} | {"file": …} |
{"content": …}]`, lowest priority first, paths relative to the case. Such a
case proves the project chain and direct files override the global directory
the way the product applies them.

A `config-invalid-root` case is a *refusal* sample rather than a derivation
one: it carries no `expected-config.json`, so the derivation tests skip it, and
instead pins the one verdict both implementations owe the operator. Its
`global/` holds a document whose root is not an object, and `expected-error.json`
names the originating document plus the key path (`""` for the root) that both
sides must report. The engine refuses the document outright
(`config_derive::load`), and the TypeScript diagnostics refuse it at the same
key path; neither may accept it in silence.
