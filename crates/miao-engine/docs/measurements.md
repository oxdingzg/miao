# miao-engine measurements

Reported per the "Measurement boundaries" section of `inventory.md`. Numbers are
a dated snapshot of one host; treat them as a reference point, not a gate. Each
section states the conditions it was taken under.

## Environment

- Date: 2026-10-10.
- Host: macOS 26.5.2, arm64, 16 GiB RAM (build host).
- Toolchain: rustc 1.99.0.
- Profile: `cargo build --release` (default release profile).

## Binary size

- `miao-engine` release binary: **19,251,552 bytes (18.4 MiB)**, macOS arm64.
- Debug symbols are stripped by the default release profile; TLS comes from the
  linked `reqwest`/`rustls` stack; there are no external runtime data files.
- Reproduce: `cargo build --release && wc -c target/release/miao-engine`.

## Headless `serve` readiness

Time from process spawn to the `listening on` line of `serve --http` (the
earliest observable "ready", excluding store/config/auth work beyond opening the
database).

- **Cold (first run): 642 ms.**
- **Warm (5 runs): p50 8.3 ms, range 7.2–11.3 ms.**
- **Idle RSS at readiness: 10 MiB.**
- Conditions: a fresh database per run, an empty workspace, provider
  `openai-chat` aimed at an unreachable endpoint so no network I/O happens before
  ready. Reported engine-process RSS only (not the process tree).

Reproduce (Python 3, on a build host):

```python
import os, subprocess, time, tempfile
bin = "target/release/miao-engine"
base = tempfile.mkdtemp(prefix="meas-")
for i in range(6):
    ws = os.path.join(base, f"w{i}"); os.makedirs(ws)
    t0 = time.perf_counter()
    p = subprocess.Popen([bin, "serve", "--db", os.path.join(base, f"r{i}.db"),
        "--workspace", ws, "--model", "m", "--provider", "openai-chat",
        "--endpoint", "http://127.0.0.1:1", "--http", "127.0.0.1:0",
        "--http-token", "t"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        env=dict(os.environ, OPENAI_API_KEY="fixture"), text=True)
    for line in p.stderr:
        if "listening on" in line:
            print((time.perf_counter() - t0) * 1000)
            break
    p.terminate(); p.wait(timeout=5)
```

## Long-session RSS

Not snapshotted here: it needs a real provider to drive turns. Procedure: run N
turns against a live provider and sample, per turn, the engine process RSS and
the full process tree RSS **separately**, recording platform, concurrency and
context size. Report as a curve, not a single number.

## Cost and context

Not snapshotted here: it needs billed provider usage. Procedure: use the
provider's billed usage including cache reads and retries; fixtures cannot
produce it. Live model-quality evaluation is tracked separately (see
`accuracy.md`).
