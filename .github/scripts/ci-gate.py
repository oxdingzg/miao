"""Classify specialist checks and enforce their actual reusable-workflow results."""
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess

CHECKS = json.loads(Path(__file__).resolve().parents[1].joinpath("ci-checks.json").read_text())


def classify(paths):
    return {name: any(fnmatchcase(path, pattern) for path in paths for pattern in patterns) for name, patterns in CHECKS.items()}


def enforce(needs, flags):
    required = {"policy", "unit", "typecheck"} | {name for name, value in flags.items() if value == "true"}
    expected_jobs = {"policy", "unit", "typecheck"} | CHECKS.keys()
    if needs.keys() != expected_jobs:
        raise ValueError(f"Unexpected gate jobs: {sorted(needs.keys() ^ expected_jobs)}")
    for job, info in needs.items():
        expected = "success" if job in required else "skipped"
        if info["result"] != expected:
            raise ValueError(f"{job}: expected {expected}, got {info['result']}")


if __name__ == "__main__":
    if "NEEDS" in os.environ:
        needs = json.loads(os.environ["NEEDS"])
        enforce(needs, needs["policy"]["outputs"])
        print("All required checks passed; unrelated checks were explicitly skipped.")
    else:
        event = os.environ["EVENT_NAME"]
        base = os.environ.get("BASE_SHA", "")
        full = event in ("schedule", "workflow_dispatch", "merge_group") or not base or set(base) == {"0"}
        revisions = [f"{base}...{os.environ['HEAD_SHA']}"] if event == "pull_request" else [base, os.environ.get("HEAD_SHA", "HEAD")]
        paths = [] if full else [path for path in subprocess.check_output(["git", "diff", "--name-only", "-z", *revisions], text=True).split("\0") if path]
        for name, value in ({name: True for name in CHECKS} if full else classify(paths)).items():
            print(f"{name}={str(value).lower()}")
