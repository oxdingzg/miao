#!/usr/bin/env python3
"""Measure application-rendered input at a POSIX PTY boundary, not kernel echo."""
import argparse
import codecs
import errno
import fcntl
import json
import os
import platform
import pty
import select
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True)
parser.add_argument("--directory", required=True)
parser.add_argument("--database", required=True)
parser.add_argument("--session", default="ses_input_latency_fixture")
parser.add_argument("--output", required=True)
parser.add_argument("--duration", type=float, default=1800)
parser.add_argument("--interval", type=float, default=15)
parser.add_argument("--commit", required=True)
args = parser.parse_args()
if args.duration <= 0 or args.interval <= 0:
    parser.error("duration and interval must be positive")

try:
    import pyte
except ImportError:
    raise SystemExit("Install the optional benchmark dependency: python3 -m pip install pyte==0.8.2")

binary = Path(args.binary).resolve()
database = Path(args.database).resolve()
directory = Path(args.directory).resolve()
if not binary.is_file() or not directory.is_dir() or not database.is_file():
    parser.error("binary, fixture directory and fixture database must exist")
# Refuse a user's working database, even if it was accidentally passed as an argument.
with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as db:
    sessions = db.execute("SELECT id FROM session").fetchall()
    messages = db.execute("SELECT count(*) FROM session_message WHERE session_id=?", (args.session,)).fetchone()[0]
    if sessions != [(args.session,)] or messages != 400:
        parser.error("database must contain only the seeded 400-message fixture")

output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
raw_limit = 32 * 1024 * 1024
screen = pyte.Screen(120, 35)
terminal = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder("utf-8")("replace")

with tempfile.TemporaryDirectory(prefix="miao-input-pty-") as home, output.open("w") as events, output.with_suffix(".pty").open("wb") as raw:
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": home, "MIAO_TEST_HOME": home, "TERM": "xterm-256color",
        "XDG_CONFIG_HOME": str(Path(home) / "config"), "XDG_DATA_HOME": str(Path(home) / "data"),
        "XDG_CACHE_HOME": str(Path(home) / "cache"), "MIAO_DB": str(database),
        "MIAO_PURE": "1", "MIAO_DISABLE_PROJECT_CONFIG": "1", "MIAO_DISABLE_AUTOUPDATE": "1",
        "MIAO_DISABLE_MODELS_FETCH": "1", "MIAO_MONITOR": "0",
        "MIAO_CONFIG_CONTENT": json.dumps({"model": "test/test-model", "lsp": False, "formatter": False, "provider": {
            "test": {"name": "Test", "id": "test", "env": [], "npm": "@ai-sdk/openai-compatible",
                     "options": {"apiKey": "fixture-key", "baseURL": "http://127.0.0.1:1"},
                     "models": {"test-model": {"id": "test-model", "name": "Test Model", "tool_call": True,
                                              "limit": {"context": 100000, "output": 10000}}}}
        }}),
    })
    version = subprocess.check_output([str(binary), "--version"], env=env, timeout=15).decode().strip()
    events.write(json.dumps({
        "type": "header", "version": version, "commit": args.commit,
        "platform": platform.system(), "architecture": platform.machine(),
        "durationSeconds": args.duration, "intervalSeconds": args.interval,
        "terminal": {"columns": 120, "rows": 35}, "rawLimitBytes": raw_limit,
        "boundary": "PTY input write to application output bytes; kernel echo disabled; excludes terminal presentation",
    }) + "\n")
    events.flush()
    pid, master = pty.fork()
    if pid == 0:
        # --port 0 chooses an embedded worker rather than starting a persistent Runtime.
        os.execve(str(binary), [str(binary), "--session", args.session, "--port", "0", str(directory)], env)
    raw_bytes = 0
    samples = []

    def receive(timeout):
        global raw_bytes
        if not select.select([master], [], [], max(0, timeout))[0]:
            return b""
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise RuntimeError("TUI exited before workload completion") from error
            raise
        if not data:
            raise RuntimeError("TUI exited before workload completion")
        if raw_bytes < raw_limit:
            raw.write(data[:raw_limit - raw_bytes])
        raw_bytes += len(data)
        terminal.feed(decoder.decode(data))
        return data

    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
        settings = termios.tcgetattr(master)
        settings[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(master, termios.TCSANOW, settings)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            receive(0.25)
            if (any("tab agents" in line for line in screen.display)
                    and any("Build" in line and "Test Model" in line for line in screen.display)
                    and screen.cursor.y >= 27):
                break
        else:
            raise RuntimeError("Session prompt did not become ready:\n" + "\n".join(screen.display[-10:]))
        started = time.monotonic()
        index = 0
        while time.monotonic() - started < args.duration:
            if termios.tcgetattr(master)[3] & termios.ECHO:
                raise RuntimeError("PTY kernel echo is enabled; input latency measurement would be invalid")
            os.write(master, b"\x15")
            until = time.monotonic() + 0.15
            while time.monotonic() < until:
                receive(0.02)
            marker = f"key{index:05d}z".encode()
            sent = time.monotonic_ns()
            os.write(master, marker)
            deadline = time.monotonic() + 5
            echoed = None
            while time.monotonic() < deadline:
                receive(0.05)
                # Reconstruct the screen: incremental frames may emit only the
                # changed digit, not an entire marker string in the raw stream.
                if any(marker.decode() in line for line in screen.display):
                    echoed = time.monotonic_ns()
                    break
            sample = {"type": "input", "index": index, "sentNs": sent, "echoedNs": echoed,
                      "latencyMs": None if echoed is None else (echoed - sent) / 1e6}
            samples.append(sample)
            events.write(json.dumps(sample) + "\n")
            events.flush()
            index += 1
            until = min(started + args.duration, time.monotonic() + args.interval)
            while time.monotonic() < until:
                receive(min(0.1, max(0, until - time.monotonic())))
        values = sorted(sample["latencyMs"] for sample in samples if sample["latencyMs"] is not None)

        def percentile(p):
            return values[min(len(values) - 1, int((len(values) - 1) * p))] if values else None

        events.write(json.dumps({"type": "summary", "elapsedSeconds": time.monotonic() - started,
                                "samples": len(samples), "timeouts": len(samples) - len(values),
                                "p50Ms": percentile(0.5), "p95Ms": percentile(0.95),
                                "p99Ms": percentile(0.99), "maxMs": max(values) if values else None,
                                "rawTruncated": raw_bytes > raw_limit}) + "\n")
        events.flush()
        if not values or len(values) != len(samples):
            raise RuntimeError("Input markers were not observed at the application PTY output boundary")
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        shutdown_deadline = time.monotonic() + 5
        forced = False
        while os.waitpid(pid, os.WNOHANG)[0] == 0:
            if time.monotonic() >= shutdown_deadline:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                forced = True
                break
            time.sleep(0.05)
        events.write(json.dumps({"type": "shutdown", "forced": forced}) + "\n")
        os.close(master)
