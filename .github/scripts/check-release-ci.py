"""Require successful main push workflows for the exact release commit."""
import argparse
import json
import os
import subprocess
import time


def require_success(runs, sha, workflow):
    matching = [run for run in runs if run["head_sha"] == sha and run["head_branch"] == "main" and run["event"] == "push"]
    if not matching:
        raise ValueError(f"{workflow}: no main push run for {sha}")
    latest = max(matching, key=lambda run: run["id"])
    if latest["status"] != "completed" or latest["conclusion"] != "success":
        raise ValueError(f"{workflow}: {latest['status']}/{latest['conclusion']} ({latest['html_url']})")
    return latest["html_url"]


POLL_SECONDS = 30
WAIT_SECONDS = 45 * 60


def fetch_runs(repo, sha, workflow):
    pages = json.loads(subprocess.check_output([
        "gh", "api", "--paginate", "--slurp",
        f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&branch=main&event=push&per_page=100",
    ], text=True))
    return [run for page in pages for run in page["workflow_runs"]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflows", nargs="+")
    parser.add_argument(
        "--wait-seconds", type=int, default=WAIT_SECONDS,
        help="how long to wait for the release commit's own CI to finish; "
        "the release is dispatched right after the merge, when that CI is "
        "usually still queued, so failing fast here turns every release into "
        "a manual re-dispatch dance",
    )
    args = parser.parse_args()
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], check=True)
    repo = os.environ["GITHUB_REPOSITORY"]
    deadline = time.monotonic() + args.wait_seconds
    for workflow in args.workflows:
        while True:
            matching = [run for run in fetch_runs(repo, sha, workflow) if run["head_sha"] == sha and run["head_branch"] == "main" and run["event"] == "push"]
            if not matching:
                if time.monotonic() >= deadline:
                    raise ValueError(f"{workflow}: no main push run appeared for {sha} within {args.wait_seconds}s")
                time.sleep(POLL_SECONDS)
                continue
            latest = max(matching, key=lambda run: run["id"])
            if latest["status"] != "completed":
                if time.monotonic() >= deadline:
                    raise ValueError(f"{workflow}: {latest['status']} for {sha} exceeded {args.wait_seconds}s ({latest['html_url']})")
                time.sleep(POLL_SECONDS)
                continue
            if latest["conclusion"] != "success":
                raise ValueError(f"{workflow}: {latest['status']}/{latest['conclusion']} ({latest['html_url']})")
            print(f"{workflow}: {latest['html_url']}")
            break


if __name__ == "__main__":
    main()
