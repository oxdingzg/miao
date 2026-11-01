#!/usr/bin/env python3
"""Measure process start -> ready-to-type at a POSIX PTY boundary.

"Ready to type" is not "a frame was painted": after the TUI's panels appear the
harness sends one character and stops the clock when that character shows up in
the rendered output. A build that renders a composer but cannot accept input is
therefore not counted as ready.

Cold runs get a fresh HOME and a fresh copy of the fixture database; warm runs
reuse both, after one warm-up run that is not recorded.
"""
import argparse
import codecs
import fcntl
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

import pyte

parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True)
parser.add_argument("--directory", required=True)
parser.add_argument("--database", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--commit", required=True)
parser.add_argument("--repeat", type=int, default=5)
parser.add_argument("--mode", choices=("cold", "warm"), default="cold")
parser.add_argument("--ready-text", action="append", default=None)
parser.add_argument("--focus-key", default=None)
parser.add_argument("--timeout", type=float, default=30.0)
parser.add_argument(
    "--env",
    action="append",
    default=None,
    metavar="KEY=VALUE",
    help="Extra environment for the measured process; repeat as needed. The "
    "harness otherwise passes a fixed fixture environment, so a run that needs "
    "a live engine passes its storage and route manifest this way.",
)
args = parser.parse_args()

if args.repeat <= 0:
    parser.error("repeat must be positive")

binary = Path(args.binary).resolve()
database = Path(args.database).resolve()
directory = Path(args.directory).resolve()
if not binary.is_file() or not database.is_file() or not directory.is_dir():
    parser.error("binary, fixture database and workspace must exist")

ready_text = args.ready_text or ["sessions", "composer"]
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)


def one_run(home: Path, db: Path) -> dict:
    screen = pyte.Screen(120, 35)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    env = {k: os.environ[k] for k in ("PATH", "LANG", "TMPDIR") if k in os.environ}
    env.update({
        "HOME": str(home), "MIAO_TEST_HOME": str(home), "TERM": "xterm-256color",
        "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
        "XDG_CACHE_HOME": str(home / "cache"), "MIAO_DB": str(db),
        "MIAO_PURE": "1", "MIAO_DISABLE_PROJECT_CONFIG": "1",
        "MIAO_DISABLE_AUTOUPDATE": "1", "MIAO_DISABLE_MODELS_FETCH": "1", "MIAO_MONITOR": "0",
    })
    for item in args.env or []:
        key, _, value = item.partition("=")
        if not key or not _:
            parser.error(f"--env expects KEY=VALUE, got {item!r}")
        env[key] = value
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
    def become_session_leader() -> None:
        # The PTY has to become the child's controlling terminal, otherwise the
        # Rust TUI cannot open /dev/tty and exits with "Inappropriate ioctl for
        # device" before painting anything.
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    started = time.monotonic_ns()
    child = subprocess.Popen([str(binary)], cwd=str(directory), env=env, stdin=slave,
                             stdout=slave, stderr=slave, preexec_fn=become_session_leader,
                             close_fds=True)
    os.close(slave)
    painted = None
    ready = None
    degraded = None

    def pump(seconds: float) -> bool:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            r, _, _ = select.select([master], [], [], 0.01)
            if master in r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                stream.feed(decoder.decode(data))
        return True

    marker = b"k"
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline and ready is None:
        if not pump(0.05):
            break
        text = "\n".join(screen.display)
        if painted is None and all(mark in text for mark in ready_text):
            painted = time.monotonic_ns()
            degraded = "engine_closed" in text
            if args.focus_key is not None:
                os.write(master, b"\t" if args.focus_key == "tab" else args.focus_key.encode())
                pump(0.2)
            os.write(master, marker)
        elif painted is not None and marker.decode() in text:
            ready = time.monotonic_ns()
    try:
        os.kill(child.pid, 15)
    except ProcessLookupError:
        pass
    os.close(master)
    return {
        "paintedMs": None if painted is None else (painted - started) / 1e6,
        "readyMs": None if ready is None else (ready - started) / 1e6,
        # A TUI that painted but lost its engine still accepts typing, so the
        # timing alone cannot say whether the run was healthy.
        "engineClosed": degraded,
    }


def percentile(values, p):
    return values[min(len(values) - 1, int((len(values) - 1) * p))] if values else None


samples = []
with tempfile.TemporaryDirectory(prefix="miao-startup-") as root:
    root_path = Path(root)
    if args.mode == "warm":
        home, db = root_path / "home", root_path / "fixture.db"
        home.mkdir()
        shutil.copy2(database, db)
        one_run(home, db)  # warm-up, deliberately not recorded
    for index in range(args.repeat):
        if args.mode == "cold":
            home = root_path / f"home-{index}"
            home.mkdir()
            db = root_path / f"fixture-{index}.db"
            shutil.copy2(database, db)
        sample = one_run(home, db)
        sample.update({"type": "startup", "index": index, "mode": args.mode})
        samples.append(sample)
        print(json.dumps(sample), flush=True)

ready = sorted(s["readyMs"] for s in samples if s["readyMs"] is not None)
painted = sorted(s["paintedMs"] for s in samples if s["paintedMs"] is not None)
summary = {
    "type": "summary", "mode": args.mode, "commit": args.commit, "repeat": args.repeat,
    "readySamples": len(ready), "timeouts": args.repeat - len(ready),
    "readyP50Ms": percentile(ready, 0.5), "readyP95Ms": percentile(ready, 0.95),
    "paintedP50Ms": percentile(painted, 0.5), "paintedP95Ms": percentile(painted, 0.95),
}
with output.open("a") as handle:
    handle.write(json.dumps({"type": "header", "commit": args.commit, "mode": args.mode,
                             "repeat": args.repeat, "binary": str(binary),
                             "boundary": "spawn to first keystroke visible; kernel echo disabled"}) + "\n")
    for sample in samples:
        handle.write(json.dumps(sample) + "\n")
    handle.write(json.dumps(summary) + "\n")
print(json.dumps(summary))
if not ready:
    raise SystemExit("no sample reached ready-to-type")
