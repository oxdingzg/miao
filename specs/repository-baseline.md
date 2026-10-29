# Frozen repository fixtures

`packages/miao/src/engine/repository-baseline.ts` defines a separate version-one
repository contract. It does not change the existing suite-v6 tasks or report
identities. The first snapshot is `oxdingzg/miao` at commit
`8ac61a6629b88939afec35d907b5570a6ce5e37a`, tree
`c94f5e0ebfce193819d4cbecfe5ab6758327bb1f`.

Create its archive without a prefix or compression:

```sh
git archive --format=tar 8ac61a6629b88939afec35d907b5570a6ce5e37a > /tmp/miao-repository-source.tar
```

The contract pins the raw archive SHA-256, task prompts, defect seeds, editable
paths, verifier source, provider/model parameters, agent, authority hashes,
repetition count, and attempt/time/cost limits. A null cost limit records an
unspecified cost limit; it is not zero cost. Callers must enforce trial budgets;
this fixture module does not call a provider or schedule repetitions.

Initialization verifies the archive before extracting into a new directory,
injects one defect in the real source tree, and fingerprints the seeded tree.
The lazy-cache task checks caching of falsy results and object identity. The
sorted-lookup task checks edge keys, absent insertion indexes, empty collections,
and logarithmic comparisons. Assessment rejects changes outside the owning
source file, including instructions, package configuration, file modes, and
symlink replacements, before starting the verifier. Verifiers have a ten-second
timeout and record exit status and output hashes.

Run the file-isolated tests from `packages/miao`:

```sh
bun run test:integration test/engine/repository-baseline.test.ts
MIAO_REPOSITORY_BASELINE_ARCHIVE=/tmp/miao-repository-source.tar bun run test:integration test/engine/repository-baseline.test.ts
```

The default tests use a small archive containing the actual utility sources.
The environment override exercises the pinned complete repository archive.
Both check seeded failures, known repairs, immutable-file tampering, symlinks,
source mismatches, and contract validation without provider charges.

An artifact pass always retains `executionVerdict: "unverified"`. It does not
prove model completion, provider accounting, or Rust/TypeScript/Codex parity.
The initial snapshot is miao itself. A separate unfamiliar repository snapshot
is available through `repositoryBaselineSource("sindresorhus/escape-string-regexp")`:

- Commit: `a7f7dabaf336bda98d2166848af15d9168b10bcf`
- Tree: `d61e3c09b705663f24473a8b05242a3e124eef18`
- Raw Git archive SHA-256: `57e81aae81daa18b2d99fd47fd124252cc5eca03786cb4d2187cf7d7dc6caf3f`

Its complete 20 KiB source archive is stored at
`packages/miao/test/fixture/repository-baseline/escape-string-regexp.tar`.
The upstream MIT license and Sindre Sorhus copyright notice remain inside the
archive, with a readable copy alongside it. The archive was produced with
`git archive --format=tar` at the pinned commit; no dependency install or network
access is required for its verifier. The original external code is not repaired
in the fixture: initialization injects a Unicode character-class range defect,
and the test proves that restoring the frozen source repairs it. Literal Unicode
matching, metacharacters, input validation, and immutable-license enforcement are
also checked. This is one small external JavaScript repository, not evidence of
general unfamiliar-repository quality. The default miao contract stays identical.

Additional task categories, execution-runner integration,
budget enforcement, repeated model trials and complete failure receipts remain
required for VAL-01 acceptance.
