"""Classify changed paths without installing workspace dependencies."""
import os
import subprocess


def classify(paths):
    code = any(
        not (path.startswith(("docs/", "specs/")) or ("/" not in path and path.endswith(".md")))
        for path in paths
    )
    windows = any(
        path.startswith((
            "packages/core/", "packages/schema/", "packages/protocol/", "packages/server/",
            "packages/miao/src/runtime/", "packages/miao/src/installation/",
            "packages/miao/test/runtime/", "packages/miao/test/installation/",
            ".github/workflows/", ".github/actions/", ".github/scripts/",
        ))
        or path in ("package.json", "bun.lock", "turbo.json", "packages/miao/package.json", "packages/miao/src/index.ts")
        or path.endswith(".ps1")
        for path in paths
    )
    return {"code": code, "windows": windows}


if __name__ == "__main__":
    base = os.environ.get("BASE_SHA", "")
    full = os.environ["EVENT_NAME"] in ("schedule", "workflow_dispatch") or not base or set(base) == {"0"}
    revisions = [f"{base}...{os.environ['HEAD_SHA']}"] if os.environ["EVENT_NAME"] == "pull_request" else [base, os.environ.get("HEAD_SHA", "HEAD")]
    paths = [] if full else subprocess.check_output(
        ["git", "diff", "--name-only", "-z", *revisions], text=True,
    ).rstrip("\0").split("\0")
    paths = [path for path in paths if path]
    for key, value in ({"code": True, "windows": True} if full else classify(paths)).items():
        print(f"{key}={str(value).lower()}")
