# Reproducible TUI input-latency benchmark

The optional POSIX benchmark harness measures how long it takes an input marker
written to a PTY to appear in application-rendered output. It does not measure
provider latency or the terminal application's actual screen presentation.

## Prepare an isolated fixture

From the repository root:

```sh
fixture=$(mktemp -d)
mkdir -p "$fixture/workspace"
MIAO_DB="$fixture/fixture.db" bun run --cwd packages/miao script/seed-input-latency.ts "$fixture/workspace"
python3 -m venv "$fixture/venv"
"$fixture/venv/bin/python" -m pip install pyte==0.8.2
```

The seeder requires a **new absolute database path** and refuses an existing
file. It creates one Session, `ses_input_latency_fixture`, containing 400 prepared
user/assistant messages and deterministic tool output. These projections are an
artificial rendering workload, not an event-replay test. The seeder uses storage
and projection services only; it does not execute a model or start an SDK server.

## Run the measurement

```sh
"$fixture/venv/bin/python" packages/miao/script/measure-input-pty.py \
  --binary "$HOME/.miao/bin/miao" \
  --directory "$fixture/workspace" \
  --database "$fixture/fixture.db" \
  --output "$fixture/input.jsonl" \
  --duration 1800 \
  --interval 15 \
  --commit "<commit-used-to-build-the-binary>"
```

Use the binary's build commit or release tag for `--commit`, not the current
checkout's commit unless that checkout built the binary. For a quick smoke test,
use `--duration 2 --interval 0.1`.

The harness:

- Refuses databases that contain any other Session or do not have the seeded
  400-message workload.
- Runs with temporary HOME/XDG directories and an explicit fixture database. It
  does not inherit provider credentials or modify the daily configuration.
- Supplies a local dummy provider/model so model selection can render without a
  connected account. It disables updates, project config, model fetching and
  resource sampling for the measurement.
- Uses `--port 0` for an embedded worker instead of leaving a persistent Runtime.
- Clears draft input, types ASCII markers and never presses Enter or submits a
  prompt.
- Disables and checks PTY kernel echo. Otherwise the line discipline could echo
  input before miao processes it, producing a falsely low latency.
- Reconstructs the terminal screen with `pyte`, including incremental cursor
  updates. Removing ANSI sequences and searching raw text alone is incorrect:
  later frames may emit only a changed digit rather than the whole marker.
- Terminates and reaps its child, using SIGKILL after five seconds if necessary.

No GUI window is opened. Python 3, a POSIX PTY and the optional `pyte==0.8.2`
benchmark dependency are required; the script is not a Windows-console benchmark.

## Artifacts and interpretation

- `input.jsonl`: version/commit/platform header, individual input samples,
  p50/p95/p99/max summary, timeout count and shutdown status.
- `input.pty`: a raw output prefix, capped at 32 MiB. The summary reports whether
  it was truncated; screen reconstruction and measurement continue past that cap.

A missing marker or readiness timeout exits non-zero rather than reporting
success. `forced: true` in the shutdown record means the child did not exit within
the five-second grace period; it was killed and reaped. Compare both latency and
cleanup behavior for the candidate and baseline binaries.

The benchmark owns only its isolated fixture. Keep its directory for comparing
multiple binaries against the same workload, then remove it when finished.
