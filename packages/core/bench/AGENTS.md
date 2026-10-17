# Request-preparation benchmarks

Budgets over the work every provider turn does before it can send anything: the
projected history is pruned and the cache policy places its breakpoints once per
step, so their cost multiplies by the steps a turn takes. A unit test cannot see
a super-linear regression here; a long session can.

## Running

```
cd packages/core && bun run bench
```

A failing budget exits non-zero and prints the offending measurement.

## Method

- Each measurement runs in a **fresh `bun` process** per sample, so a sample
  cannot inherit another sample's warm JIT, module cache, or heap.
- Five samples, **median** reported. Budgets are `reference × 3 × 1.25`: the
  factor covers continuous-integration runners being slower and noisier than a
  developer machine, the headroom one-off scheduler noise. Both are reviewed
  source constants in `lib/harness.ts`; nothing overrides them from the
  environment, because a budget that can be raised at runtime guards nothing.
- Measurements that come in small and large sizes carry a **complexity bound**
  (the ratio between them) so a change that is linear today cannot quietly
  become quadratic tomorrow.
- `referenceMs` values are the local median rounded up by about four times.
  Tighten them from the numbers a continuous-integration run reports.

## Scope

These measure preparation, not the provider turn: the request build, pruning,
and the cache policy are pure and need no network, no database, and no recorded
stream. The provider-turn and session-open paths need recorded fixtures and a
database harness first, and should be added here rather than approximated with a
fake provider that would measure the fake.

Budgets are compared in this package only. The gate is not yet wired into
`ci.yml`; a job belongs next to the other required checks once the constants are
calibrated against a real runner.
