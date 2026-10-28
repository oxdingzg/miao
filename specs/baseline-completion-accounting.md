# Baseline completion accounting

Baseline reports retain all recorded attempts, including retries, failed runs,
and runs whose completion could not be verified. `perCompletedTask` divides
those totals by the number of runs whose verified outcome is `passed`.
For example, two verified successes and two failures costing 0.40 in total
report 0.20 per completed task, rather than the cost of successful runs alone.
Elapsed time uses the same denominator and includes time spent on every run.

Input tokens, output tokens, and cost have independent coverage. A missing value
makes that dimension unknown; it never contributes a fabricated zero. An empty
attempt list in raw evidence also leaves usage and cost unknown, because a run
interrupted before recording usage may still have incurred cost. Recorded zero
usage remains zero. With no verified success, all per-completion values are
unknown, even when the recorded totals are known.

The evidence summary CLI displays failed and unverified counts separately and
uses `unknown` for missing coverage. The strict baseline report continues to
reject missing execution accounting, foreign fixtures, invalid provenance,
duplicates, and malformed usage. Comparable full-suite coverage and the default
engine switch gates are unchanged. These are recorded measurements, not invoice
reconciliation or evidence that either engine is cheaper or more capable.

Verification uses local fixtures only. Real repository quality acceptance and
paid provider comparisons require their own evidence and remain separate gates.

Rust evidence also retains `role.provider.completed` calls alongside primary
usage rows. Auxiliary rows identify the role, model, protocol, receipt sequence,
recorded time, provider success and semantic acceptance when reported. Failed
calls without usage retain null axes and cost. These are auxiliary calls observed
on the subscribed Session; this does not establish complete child-Session retry
coverage, role-profile comparability or historical price attribution.
