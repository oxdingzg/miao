#!/usr/bin/env python3
"""Recompute this record's tables from the raw evidence files.

The evidence comes from `script/engine-benchmark.ts --data <dir>`, which writes
one JSON per attempt under raw/<engine>/evidence/. Python 3 standard library
only:

    analyze.py                     # writes results.csv and results.md

Every figure in README.md must be reproducible from this script alone.
"""
import glob
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
ARMS = ("ts", "rust")
BUDGET_USD = 0.01


def load(arm, subdir="evidence"):
    rows = []
    for path in sorted(glob.glob(os.path.join(HERE, "raw", arm, subdir, "*.json"))):
        rows.append(json.load(open(path)))
    return rows


def corrected(rows, rerun):
    """Replace a family's contaminated samples with its re-measured ones."""
    replaced = {row["task"] for row in rerun}
    return [row for row in rows if row["task"] not in replaced] + rerun


def pct(values, p):
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((p / 100) * len(ordered)))]


def summarize(rows):
    passed = [row for row in rows if row["ok"]]
    priced = [row for row in rows if row.get("costUnknown", 0) == 0]
    priced_passed = [row for row in passed if row.get("costUnknown", 0) == 0]
    tasks = sorted({row["task"] for row in rows})
    within = 0
    for task in tasks:
        cheapest = [row["cost"] for row in priced_passed if row["task"] == task]
        if cheapest and min(cheapest) <= BUDGET_USD:
            within += 1
    return {
        "runs": len(rows),
        "passed": len(passed),
        "tasks": tasks,
        "within_budget": within,
        "billed_p50": pct([row["billedIn"] for row in rows], 50),
        "billed_p95": pct([row["billedIn"] for row in rows], 95),
        "cost_p50": pct([row["cost"] for row in priced], 50),
        "cost_p95": pct([row["cost"] for row in priced], 95),
        "cost_total": None if len(priced) != len(rows) else sum(row["cost"] for row in rows),
        "cost_per_success": None
        if not passed or len(priced_passed) != len(passed)
        else sum(row["cost"] for row in passed) / len(passed),
        "seconds_p50": pct([row["seconds"] for row in rows], 50),
        "seconds_p95": pct([row["seconds"] for row in rows], 95),
        "unknown": sum(1 for row in rows if row.get("costUnknown", 0) > 0),
    }


def write_csv(data):
    header = [
        "model",
        "scope",
        "engine",
        "task",
        "runs",
        "passed",
        "attempts",
        "billed_input",
        "cached_input",
        "output",
        "cost",
        "unknown_cost_steps",
        "p50_ms",
        "p95_ms",
    ]
    lines = [",".join(header)]
    for arm in ARMS:
        rows = data[arm]["rows"]
        for scope in ["total"] + sorted({row["task"] for row in rows}):
            subset = rows if scope == "total" else [row for row in rows if row["task"] == scope]
            if not subset:
                continue
            cost = sum(row["cost"] for row in subset)
            lines.append(
                ",".join(
                    str(value)
                    for value in [
                        subset[0]["model"],
                        "total" if scope == "total" else "task",
                        arm,
                        "*" if scope == "total" else scope,
                        len(subset),
                        sum(1 for row in subset if row["ok"]),
                        sum(row["turns"] for row in subset),
                        sum(row["input"] for row in subset),
                        sum(row["cacheRead"] for row in subset),
                        sum(row["output"] for row in subset),
                        round(cost, 5),
                        sum(row.get("costUnknown", 0) for row in subset),
                        round(pct([row["seconds"] * 1000 for row in subset], 50)),
                        round(pct([row["seconds"] * 1000 for row in subset], 95)),
                    ]
                )
            )
    open(os.path.join(HERE, "results.csv"), "w").write("\n".join(lines) + "\n")


def money(value):
    return "unknown" if value is None else f"${value:.4f}"


def write_markdown(data):
    ts, rs = data["ts"]["summary"], data["rust"]["summary"]
    lines = ["# Results", ""]
    lines.append("| arm | runs | passed | billed-in p50 | billed-in p95 | $ p50 | $ p95 | s p50 | s p95 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm, summary in (("typescript", ts), ("rust", rs)):
        lines.append(
            f"| {arm} | {summary['runs']} | {summary['passed']}/{summary['runs']} "
            f"| {summary['billed_p50']} | {summary['billed_p95']} | {money(summary['cost_p50'])} "
            f"| {money(summary['cost_p95'])} | {summary['seconds_p50']:.0f} | {summary['seconds_p95']:.0f} |"
        )
    lines.append("")
    lines.append("| arm | success rate | total $ | $ per verified success | tasks within budget |")
    lines.append("| --- | --- | --- | --- | --- |")
    for arm, summary in (("typescript", ts), ("rust", rs)):
        lines.append(
            f"| {arm} | {summary['passed']}/{summary['runs']} "
            f"({summary['passed'] * 100 // summary['runs']}%) | {money(summary['cost_total'])} "
            f"| {money(summary['cost_per_success'])} | {summary['within_budget']}/{len(summary['tasks'])} |"
        )
    lines.append("")
    lines.append("| task | ts pass | rust pass | ts billed-in p50 | rust billed-in p50 | ts $ p50 | rust $ p50 | ts s p50 | rust s p50 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for task in sorted(ts["tasks"]):
        per = {}
        for arm in ARMS:
            rows = [row for row in data[arm]["rows"] if row["task"] == task]
            per[arm] = (sum(1 for row in rows if row["ok"]), len(rows), summarize(rows))
        lines.append(
            f"| {task} | {per['ts'][0]}/{per['ts'][1]} | {per['rust'][0]}/{per['rust'][1]} "
            f"| {per['ts'][2]['billed_p50']} | {per['rust'][2]['billed_p50']} "
            f"| {money(per['ts'][2]['cost_p50'])} | {money(per['rust'][2]['cost_p50'])} "
            f"| {per['ts'][2]['seconds_p50']:.0f} | {per['rust'][2]['seconds_p50']:.0f} |"
        )
    lines.append("")
    lines.append("## Corrected view")
    lines.append("")
    lines.append(
        "`unfamiliar-repo` could not parse before #2205 (see README), so the measured table above counts its "
        "failures as model results. This table replaces that family with its re-measured samples from "
        "`raw/<arm>/rerun/evidence/` and leaves every other sample untouched."
    )
    lines.append("")
    lines.append("| arm | runs | passed | total $ | $ per verified success | tasks within budget |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for arm in ARMS:
        summary = data[arm]["corrected"]
        lines.append(
            f"| {arm} | {summary['runs']} | {summary['passed']}/{summary['runs']} "
            f"({summary['passed'] * 100 // summary['runs']}%) | {money(summary['cost_total'])} "
            f"| {money(summary['cost_per_success'])} | {summary['within_budget']}/{len(summary['tasks'])} |"
        )
    failures = [(arm, row) for arm in ARMS for row in data[arm]["rows"] if not row["ok"]]
    lines.append("")
    lines.append(f"Failed samples: {len(failures)} of {ts['runs'] + rs['runs']} (all listed, none dropped).")
    for arm, row in failures:
        reason = (row.get("verifyError") or "unknown").strip().splitlines()[0]
        lines.append(f"- {arm}/{row['task']}#{row['attempt']}: {reason}")
    open(os.path.join(HERE, "results.md"), "w").write("\n".join(lines) + "\n")


def main():
    data = {arm: {"rows": load(arm)} for arm in ARMS}
    for arm in ARMS:
        rerun = load(arm, os.path.join("rerun", "evidence"))
        data[arm]["summary"] = summarize(data[arm]["rows"])
        data[arm]["rerun"] = rerun
        data[arm]["corrected_rows"] = corrected(data[arm]["rows"], rerun)
        data[arm]["corrected"] = summarize(data[arm]["corrected_rows"])
    write_csv(data)
    write_markdown(data)
    for arm in ARMS:
        for label, summary in (("measured", data[arm]["summary"]), ("corrected", data[arm]["corrected"])):
            print(
                f"{arm} {label}: {summary['passed']}/{summary['runs']} passed, "
                f"total {money(summary['cost_total'])}, {money(summary['cost_per_success'])} per success, "
                f"{summary['within_budget']}/{len(summary['tasks'])} within budget, "
                f"{summary['unknown']} unpriced samples"
            )


if __name__ == "__main__":
    main()
