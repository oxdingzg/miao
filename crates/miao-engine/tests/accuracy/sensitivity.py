"""Prove the accuracy checks detect faults, in a disposable build checkout.

Run from crates/miao-engine on a build host:
    python3 tests/accuracy/sensitivity.py

Each mutation must cause a test assertion failure (not a compile failure).
Sources/fixtures are restored in finally blocks, even if a probe fails.
Do not run concurrently with another build in this checkout.
"""
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
env = dict(os.environ)
env.pop("MIAO_UPDATE_GOLDEN", None)


def run(target, case=None):
    args = ["cargo", "test", "--test", target]
    if case:
        args.extend([case, "--", "--exact"])
    return subprocess.run(args, cwd=root, env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)


for target in ("accuracy", "differential"):
    baseline = run(target)
    if baseline.returncode:
        raise RuntimeError("baseline must pass before fault injection:\n" + baseline.stdout)


def probe(name, path, mutate, target, case=None):
    original = path.read_text()
    changed = mutate(original)
    if changed == original:
        raise RuntimeError(name + ": mutation did not change the fixture")
    try:
        path.write_text(changed)
        result = run(target, case)
        if result.returncode == 0 or "test result: FAILED" not in result.stdout:
            raise RuntimeError(name + ": expected an assertion failure:\n" + result.stdout)
        print("DETECTED: " + name, flush=True)
    finally:
        path.write_text(original)


def missing_event(text):
    events = json.loads(text)
    events.pop(3)
    return json.dumps(events, indent=2)


def schema_drift(text):
    catalog = json.loads(text)
    catalog["read_file"]["required"] = []
    return json.dumps(catalog, indent=2)


def wrong_reference(text):
    corpus = json.loads(text)
    corpus[0]["reference"]["a.txt"] = "incorrect\n"
    return json.dumps(corpus, indent=2)


probe("missing lifecycle event", root / "tests/accuracy/fix-transcript.json",
      missing_event, "accuracy", "product_fix_has_correct_files_replay_and_model_contract")
probe("tool schema drift", root / "tests/accuracy/read-only-tool-schemas.json",
      schema_drift, "accuracy", "read_only_tool_schema_contract")
probe("wrong patch reference", root / "tests/differential/patch_corpus.json",
      wrong_reference, "differential")
probe("wrong on-disk fix", root / "tests/accuracy.rs",
      lambda text: text.replace("+4\\n keep", "+5\\n keep"), "accuracy",
      "product_fix_has_correct_files_replay_and_model_contract")

for target in ("accuracy", "differential"):
    restored = run(target)
    if restored.returncode:
        raise RuntimeError("restored sources must pass:\n" + restored.stdout)
print("SENSITIVITY_OK: all four faults detected; restored baselines pass", flush=True)
