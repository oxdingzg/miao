# miao-engine measurements

Reported per the "Measurement boundaries" section of `inventory.md`. Numbers are
a dated snapshot of one host; treat them as a reference point, not a gate. Each
section states the conditions it was taken under.

## Environment

- Date: 2026-10-10.
- Host: macOS 26.5.2, arm64, 16 GiB RAM (build host).
- Toolchain: rustc 1.99.0.
- Profile: `cargo build --release` (default release profile).

## Input echo latency (PERF-01)

Typing responsiveness of the TUI composer: one byte is written to the PTY at
a time and the time until that byte appears in the rendered output stream is
recorded. The harness lives in `crates/miao-tui/tests/input_latency.rs`
(`cargo test --manifest-path crates/miao-tui/Cargo.toml --test input_latency
-- --nocapture`) and writes a JSON report beside its workspace.

Gate (target, not a current result): p95 ≤ 50 ms, p99 ≤ 100 ms on a pinned
machine, re-measured under streaming output and long-history load before the
gate is claimed.

Latest run (2026-10-31, macmini M-series, PTY 80×24, TUI against the scripted
engine, 36 distinct keystrokes after entering a session):

| scenario          | samples | p50 | p95 | p99 | max |
| ----------------- | ------- | --- | --- | --- | --- |
| composer-idle     | 36      | 1 ms | 2 ms | 3 ms | 3 ms |
| composer-streaming (during fake-engine session updates) | 36 | 1 ms | 2 ms | 2 ms | 2 ms |

Not yet covered: echo latency under a 10k-line history and with
input-method composition (the PTY harness cannot drive OS-level IM
composition; both remain tracked on #1921).

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

## Read batch (ADR-13)

Context: [`0013-bounded-parallel-tools.md`](adr/0013-bounded-parallel-tools.md).
Harness: `crates/miao-engine/tests/read_batch_measurement.rs` (ignored by
default; it prints these numbers rather than gating on them). The behavioural
guarantees — membership by declaration, write barriers, ordered settlement —
are pinned by `crates/miao-engine/tests/read_batch.rs`.

Two cells issue the same eight `read_file` calls in one provider turn against
the same fixture files, plus one identical `write_file`. Only the write's
position differs: in the control it sits after the first read and ends the
declared-read prefix, so all eight reads settle serially in request order; in
the batch cell all eight are admitted together through `buffer_unordered(4)`.
Same reads, same write, same turn count. A single-read cell measures the fixed
per-run floor at 6 ms.

- Date: 2026-10-29.
- Host: macOS arm64 (build host), `cargo test --release`, rustc 1.99.0.
- Fixture: eight files of 32,000 bytes each — the largest an unranged
  `read_file` accepts; a bigger file is refused before any read happens.
- 21 paired rounds per run: both cells run back to back and only their order
  swaps, so drift between rounds cancels instead of inflating one cell.

| Run | Paired delta (serial − batch), median | Spread |
| --- | ---: | --- |
| 1 | 1 ms | −14 … +7 ms |
| 2 | −1 ms | −3 … +9 ms |
| 3 | 4 ms | −3 … +11 ms |
| 4 | 5 ms | −32 … +23 ms |

- **No reproducible wall-clock gain.** Four runs put the paired median between
  −1 and +5 ms on a ~30 ms cell, with spreads wider than the effect. An earlier
  unpaired version of this harness reported a steady 15–18% “win” that
  disappeared once the cells were paired: the apparent gain was the order the
  cells ran in, not the batch.
- The overlap path does run: only the batch cell records
  `tool.parallel.started` with eight call ids and `concurrency: 4`.
- Why the admission limit does not become a speedup: `read_file` is bounded to
  32 KiB unranged and 1 MiB ranged, so each read's I/O is trivial, and the
  remaining per-call cost is in-process work (hash, snapshot registration,
  event and settlement writes on one runtime and one SQLite connection) which
  `buffer_unordered` interleaves but cannot parallelize. Batching is a
  scheduling guarantee, not a measured speed feature.
- **Cost is unchanged.** Both cells issue the same nine calls in one provider
  turn and settle in provider call order, so the model sees identical results
  and batching spends no extra tokens.

Treat this as one host, one fixture, one profile — a reference point, not a
gate. Any future claim that the batch is faster has to beat the paired spread
above.

Reproduce on a build host:

```text
cd crates/miao-engine
cargo test --release --test read_batch_measurement -- --ignored --nocapture --test-threads=1
```
