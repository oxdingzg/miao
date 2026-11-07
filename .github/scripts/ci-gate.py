"""Classify specialist checks and enforce their actual reusable-workflow results."""
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess
import sys

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


def known(revision):
    """Whether this clone holds the commit a push event named.

    `github.event.before` can name a commit the clone never sees: when main is
    rewritten, the previous tip stays on no ref, and a shallow failure here
    turned into `fatal: bad object` plus a failed policy job for a commit that
    only needed classifying.
    """
    if not revision:
        return False
    return subprocess.run(["git", "cat-file", "-e", f"{revision}^{{commit}}"], capture_output=True).returncode == 0


if __name__ == "__main__":
    if "NEEDS" in os.environ:
        needs = json.loads(os.environ["NEEDS"])
        enforce(needs, needs["policy"]["outputs"])
        print("All required checks passed; unrelated checks were explicitly skipped.")
    else:
        event = os.environ["EVENT_NAME"]
        base = os.environ.get("BASE_SHA", "")
        head = os.environ.get("HEAD_SHA", "HEAD")
        scheduled = event in ("schedule", "workflow_dispatch", "merge_group")
        full = scheduled or not known(base) or not known(head)
        if full and not scheduled:
            print(f"ci-gate: {base or '(none)'}..{head} is not in this clone; classifying every check", file=sys.stderr)
        revisions = [f"{base}...{head}"] if event == "pull_request" else [base, head]
        paths = [] if full else [path for path in subprocess.check_output(["git", "diff", "--name-only", "-z", *revisions], text=True).split("\0") if path]
        for name, value in ({name: True for name in CHECKS} if full else classify(paths)).items():
            print(f"{name}={str(value).lower()}")
