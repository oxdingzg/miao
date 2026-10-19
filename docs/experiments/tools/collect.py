#!/usr/bin/env python3
"""Assemble one experiment directory from baseline sweep chunk outputs.

A live comparison runs in chunks (one sweep invocation per group of classes),
so the raw evidence ends up in several directories. This collects one engine's
chunks into `raw/<engine>/`, merges the samples, and writes a sanitized sweep
summary that keeps the binary's digest but drops its host path.

    collect.py --out docs/experiments/<run> --engine rust \
      --chunk /tmp/eval/rs-1 --chunk /tmp/eval/rs-2 --model deepseek-v4-flash \
      --revision "$(git rev-parse HEAD)"

Run it once per engine; the manifest is merged across runs. Python 3 stdlib only.
"""
import argparse
import glob
import json
import os
import shutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--engine", required=True, choices=["typescript", "rust"])
    parser.add_argument("--chunk", action="append", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--command", action="append", default=[], help="the sweep command line for each chunk, in order")
    options = parser.parse_args()
    if options.command and len(options.command) != len(options.chunk):
        raise SystemExit("--command needs one entry per --chunk")

    target = os.path.join(options.out, "raw", options.engine)
    os.makedirs(os.path.join(target, "evidence"), exist_ok=True)
    samples, sweeps, binary = [], [], None
    for chunk in options.chunk:
        for path in glob.glob(os.path.join(chunk, "evidence", "*.json")):
            shutil.copyfile(path, os.path.join(target, "evidence", os.path.basename(path)))
        samples.extend(json.load(open(os.path.join(chunk, "samples.json"))))
        sweep = json.load(open(os.path.join(chunk, "sweep.json")))
        binary = binary or sweep.get("binarySha256")
        sweep.pop("binary", None)  # a host path does not belong in the record
        sweep["chunk"] = os.path.basename(chunk)
        sweeps.append(sweep)

    json.dump(samples, open(os.path.join(target, "samples.json"), "w"), indent=1)
    json.dump(sweeps, open(os.path.join(target, "sweeps.json"), "w"), indent=1)

    manifest_path = os.path.join(options.out, "manifest.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {"arms": {}}
    manifest["arms"][options.engine] = {
        "model": options.model,
        "revision": options.revision,
        "binarySha256": binary,
        "suiteHash": sweeps[0]["suiteHash"],
        "tasks": [task for sweep in sweeps for task in sweep["tasks"]],
        "repetitions": sweeps[0]["repetitions"],
        "runs": sum(sweep["samples"] for sweep in sweeps),
        "rejected": sum(sweep["rejected"] for sweep in sweeps),
        "chunks": [os.path.basename(chunk) for chunk in options.chunk],
        "commands": options.command,
    }
    manifest["arms"][options.engine]["startedAtMs"] = min(sweep["startedAtMs"] for sweep in sweeps)
    manifest["arms"][options.engine]["finishedAtMs"] = max(sweep["finishedAtMs"] for sweep in sweeps)
    json.dump(manifest, open(manifest_path, "w"), indent=1)
    print(json.dumps(manifest["arms"][options.engine], indent=1))


if __name__ == "__main__":
    main()
