#!/usr/bin/env python3
"""Compare two baseline sweeps from their evidence files.

Both arms must be the same frozen suite, model, and repetitions. The script
reports success, turns, billed/cached input, output, cost, latency, the
per-class split, and the output/input price ratio at which the cheaper arm
stops being cheaper. Python 3 standard library only.

    compare.py --typescript raw/typescript --rust raw/rust --prices prices.json
    compare.py ... --csv results.csv --markdown results.md
"""
import argparse
import glob
import json
import os
import statistics
import sys


def load(directory):
    runs = []
    for path in sorted(glob.glob(os.path.join(directory, "evidence", "*.json"))):
        record = json.load(open(path))
        evidence = record["evidence"]
        sample = record.get("sample")
        runs.append(
            {
                "task": evidence["task"],
                "repetition": evidence["repetition"],
                "outcome": sample["outcome"] if sample else "rejected",
                "rejection": record.get("rejection"),
                "elapsed": evidence["elapsedMs"],
                "attempts": evidence["attempts"],
                "toolCalls": evidence.get("toolCalls") or 0,
                "receipts": evidence.get("receipts") or [],
            }
        )
    return runs


def tokens(runs):
    attempts = [attempt for run in runs for attempt in run["attempts"]]
    # inputTokens is the inclusive prompt total (the LLM.Usage invariant:
    # nonCached + cacheRead + cacheWrite = input), so billed input excludes the
    # cached portion.
    total_input = sum(attempt["inputTokens"] or 0 for attempt in attempts)
    cached = sum(attempt.get("cacheReadTokens") or 0 for attempt in attempts)
    output = sum(attempt["outputTokens"] or 0 for attempt in attempts)
    return {
        "billed_input": total_input - cached,
        "cached_input": cached,
        "output": output,
        "input": total_input,
    }


def cost(runs, prices):
    spend = tokens(runs)
    return (
        spend["billed_input"] * prices["input"]
        + spend["cached_input"] * prices["cache_read"]
        + spend["output"] * prices["output"]
    ) / 1_000_000


def summarize(runs, prices):
    spend = tokens(runs)
    latencies = sorted(run["elapsed"] for run in runs)
    passed = sum(1 for run in runs if run["outcome"] == "passed")
    attempts = sum(len(run["attempts"]) for run in runs)
    return {
        "runs": len(runs),
        "passed": passed,
        "failed": len(runs) - passed,
        "attempts": attempts,
        "turns_per_run": round(attempts / len(runs), 2) if runs else 0,
        **spend,
        "hit_rate": round(spend["cached_input"] / spend["input"] * 100, 1) if spend["input"] else 0,
        "cost": round(cost(runs, prices), 5),
        "p50_ms": latencies[len(latencies) // 2] if latencies else 0,
        "p95_ms": latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else 0,
    }


def break_even(ts, rs, prices):
    """Output/input rate ratio at which the two arms cost the same.

    Only meaningful when the native arm has more output and less billed input,
    which is the shape this comparison keeps producing.
    """
    delta_billed = ts["billed_input"] - rs["billed_input"]
    delta_cached = rs["cached_input"] - ts["cached_input"]
    delta_output = rs["output"] - ts["output"]
    if delta_output == 0:
        return None
    # cost_rs - cost_ts = 0 at output rate O:
    #   -delta_billed*I + delta_cached*C + delta_output*O = 0
    output_rate = (delta_billed * prices["input"] - delta_cached * prices["cache_read"]) / delta_output
    if output_rate <= 0:
        return None
    return round(output_rate / prices["input"], 2)


def ratio(ts, rs):
    return round(rs["cost"] / ts["cost"], 3) if ts["cost"] else None


def rows(ts_runs, rs_runs, ts, rs, prices):
    out = []
    for engine, runs, totals in (("typescript", ts_runs, ts), ("rust", rs_runs, rs)):
        out.append(
            {
                "scope": "total",
                "engine": engine,
                "task": "*",
                "runs": totals["runs"],
                "passed": totals["passed"],
                "attempts": totals["attempts"],
                **{key: totals[key] for key in ("billed_input", "cached_input", "output")},
                "cost": totals["cost"],
                "p50_ms": totals["p50_ms"],
                "p95_ms": totals["p95_ms"],
            }
        )
    for task in sorted({run["task"] for run in ts_runs + rs_runs}):
        for engine, runs, totals in (("typescript", ts_runs, ts), ("rust", rs_runs, rs)):
            subset = [run for run in runs if run["task"] == task]
            if not subset:
                continue
            item = summarize(subset, prices)
            out.append(
                {
                    "scope": "task",
                    "engine": engine,
                    "task": task,
                    "runs": item["runs"],
                    "passed": item["passed"],
                    "attempts": item["attempts"],
                    **{key: item[key] for key in ("billed_input", "cached_input", "output")},
                    "cost": item["cost"],
                    "p50_ms": item["p50_ms"],
                    "p95_ms": item["p95_ms"],
                }
            )
    return out


def markdown(ts, rs, ts_runs, rs_runs, prices, excludes):
    lines = []
    lines.append("| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for name, item in (("TypeScript", ts), ("Rust", rs)):
        lines.append(
            f"| {name} | {item['passed']}/{item['runs']} | {item['attempts']} ({item['turns_per_run']}/run) | "
            f"{item['billed_input']:,} | {item['cached_input']:,} | {item['hit_rate']}% | {item['output']:,} | "
            f"${item['cost']:.5f} | {item['p50_ms'] / 1000:.1f} s | {item['p95_ms'] / 1000:.1f} s |"
        )
    lines.append("")
    lines.append(f"Rust/TypeScript cost ratio: **{ratio(ts, rs)}**; break-even output/input rate ratio: "
                 f"**{break_even(ts, rs, prices)}** (output rate currently {round(prices['output'] / prices['input'], 2)}× input).")
    lines.append("")
    lines.append("| Class | TS cost | Rust cost | Rust/TS |")
    lines.append("| --- | --- | --- | --- |")
    for task in sorted({run["task"] for run in ts_runs + rs_runs}):
        ts_item = summarize([run for run in ts_runs if run["task"] == task], prices)
        rs_item = summarize([run for run in rs_runs if run["task"] == task], prices)
        lines.append(f"| {task} | ${ts_item['cost']:.5f} | ${rs_item['cost']:.5f} | {ratio(ts_item, rs_item)} |")
    for exclude in excludes:
        ts_item = summarize([run for run in ts_runs if run["task"] != exclude], prices)
        rs_item = summarize([run for run in rs_runs if run["task"] != exclude], prices)
        lines.append("")
        lines.append(f"Excluding `{exclude}`: TS ${ts_item['cost']:.5f}, Rust ${rs_item['cost']:.5f}, "
                     f"ratio {ratio(ts_item, rs_item)}.")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--typescript", required=True)
    parser.add_argument("--rust", required=True)
    parser.add_argument("--prices", required=True, help="JSON file with input/output/cache_read rates per million tokens")
    parser.add_argument("--exclude", action="append", default=[], help="class to also total without")
    parser.add_argument("--csv")
    parser.add_argument("--markdown")
    options = parser.parse_args()

    prices = json.load(open(options.prices))
    # A prices file may carry its source and date beside the rates.
    prices = prices.get("rates_per_million_tokens", prices)
    missing = [key for key in ("input", "output", "cache_read") if key not in prices]
    if missing:
        sys.exit(f"prices file is missing {', '.join(missing)}")
    ts_runs, rs_runs = load(options.typescript), load(options.rust)
    if not ts_runs or not rs_runs:
        sys.exit("both arms need evidence files")
    ts, rs = summarize(ts_runs, prices), summarize(rs_runs, prices)
    print(markdown(ts, rs, ts_runs, rs_runs, prices, options.exclude), end="")
    if options.csv:
        fields = list(rows(ts_runs, rs_runs, ts, rs, prices)[0].keys())
        with open(options.csv, "w") as handle:
            handle.write(",".join(fields) + "\n")
            for row in rows(ts_runs, rs_runs, ts, rs, prices):
                handle.write(",".join(str(row[field]) for field in fields) + "\n")
    if options.markdown:
        open(options.markdown, "w").write(markdown(ts, rs, ts_runs, rs_runs, prices, options.exclude))


if __name__ == "__main__":
    main()
