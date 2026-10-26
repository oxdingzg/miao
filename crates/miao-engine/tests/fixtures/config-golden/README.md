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
