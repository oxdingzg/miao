# Session blackbox

The blackbox records external execution boundaries and compares their semantic results. It is opt-in diagnostics, outside both engines' authoritative stores. A bundle is not a recovery instruction and must never be replayed into a user's live Session or workspace.

## Implemented boundaries

- The TypeScript Session runner records transport-free model requests, individual LLM events, classified stream failures, local tool requests/results, and starting/finished history plus pending-input checkpoints.
- TypeScript replay validates every request before returning recorded events/results. It does not call the live provider factory or local tool executor. Final projected history is checked too.
- A loopback HTTP recorder/replayer works with both TypeScript HTTP routes and Rust sidecars. It retains response status, bytes, chunk timing, and terminal transport outcome. Authorization/request headers and response cookies are not persisted.
- The headless Rust driver records and checks engine events with explicit identity correlation. Provider replay works with the real sidecar and no upstream server.
- A structural comparator reports the first mismatch within a causal lane. Independent Session interleaving is irrelevant; order within a lane is significant. Missing interactions, incomplete recordings, changed context, tool input/result changes, and unconsumed replay are failures.

Rust's native tools currently execute in the supplied fixture workspace; this driver is not a native-tool shadow executor. Its approval decision defaults to deny. Use disposable workspaces, fresh databases, and controlled fixtures for native-tool scenarios. The TypeScript tool boundary already substitutes recorded settlements without executing tools. Full cross-engine tool-result substitution and a common product-history adapter are further gates before the B1 default switch.

## Bundle contract

`format: "miao-blackbox"`, `version: 1`. Metadata identifies the engine/scenario; interactions have a causal lane and ordinal, request, timed frames, terminal outcome, and optional classified error. Trace entries identify a Session lane, kind, semantic data, and nullable recording time.

The file contains a SHA-256 digest of canonical bundle JSON. Object key order is ignored, arrays are ordered, and scalar types stay significant. The digest detects accidental corruption; it is not a signature. Bundle decoding validates the version, lane order, and frame timing. Replay is fail-closed: no search-ahead, fuzzy matching, or fallback to live IO. A mismatched replay is poisoned so a subsequent retry cannot accidentally consume the original response.

Recording writes an incomplete interaction before calling the external boundary. Atomic snapshots use private file permissions (`0600`) and newly created directories use `0700`. A crash can leave an explicit incomplete interaction, which replay refuses. Large streamed recordings rewrite the snapshot per frame, so enable this diagnostic mode for scoped reproductions rather than treating it as an always-on performance trace.

Prompts, file contents, tool results, and model outputs are sensitive even without credentials. Keep bundles private and review them before sharing. Semantic provider options and request bodies are retained; do not put credentials in those fields. The HTTP boundary omits query parameters; configure authentication on the fixed upstream endpoint or in headers. Use a separate recorder per provider route and Session rather than multiplexing unrelated requests into one lane.

## Record/replay a TypeScript Session

From `packages/miao`, run the source CLI with an isolated channel/database and the same model/agent configuration for both runs:

```sh
MIAO_BLACKBOX_RECORD=/private/path/recordings \
  bun --conditions=browser src/index.ts run --model PROVIDER/MODEL "Use the fixture tool"
```

The snapshot is `/private/path/recordings/<sessionID>.json`. During recording, a private, hash-chained `<sessionID>.json.journal` sidecar durably appends individual frames. The provider hot path never rewrites the whole Session. Snapshots are packaged at interaction and history boundaries; `BlackboxTape.load` also recovers newer partial output from the journal after a crash, preserving incomplete outcomes. Keep both files when collecting a recording from an interrupted process. Settled snapshots remain standalone, and older snapshots without a journal remain readable. Do not combine `MIAO_BLACKBOX_RECORD` and `MIAO_BLACKBOX_REPLAY`.

```sh
MIAO_BLACKBOX_REPLAY=/private/path/recordings/ses_example.json \
  bun --conditions=browser src/index.ts run --model PROVIDER/MODEL "Use the fixture tool"
```

Replay uses a new isolated Session with the same semantic initial history, queued inputs, system context, configuration, and fixture paths. Model selection/configuration still happens normally, but recorded provider and tool boundaries perform no live IO. A replay bundle is restricted to one Session. Multi-drain bundles require the same sequence of admitted prompts and delivery modes; the runner does not automatically re-admit prompts from a recording. Harnesses must call `Replay.assertConsumed()` after their whole scenario, not after an intermediate drain.

The generated `msg_` identities in model requests are correlated by first occurrence; provider tool-call identities are retained. Projected-history checkpoints omit product message IDs, observation times, snapshot handles, and TTFT. Agent/model selection, message order/content, tool state/results, finish/error state, and pending prompt/delivery order remain significant. Source timing remains available in recordings; this semantic comparison does not prove timestamp equivalence.

For tests/custom hosts, provide `SessionBlackbox.Current` to the actual runner execution Context. A Context override on an advisory wake's caller does not automatically cross the process coordinator and Location runtime boundary.

## HTTP boundary

From `packages/miao`:

```sh
bun src/blackbox/cli.ts record \
  --bundle /private/path/provider.json \
  --upstream https://api.example.test/v1/chat/completions \
  --engine ts --port 8099
```

Point the engine's provider endpoint at `http://127.0.0.1:8099/chat/completions`. Incoming requests cannot choose the upstream destination. Stop with SIGINT/SIGTERM after the scenario completes.

```sh
bun src/blackbox/cli.ts replay \
  --bundle /private/path/provider.json --port 8099 --timing
```

`--timing` preserves relative chunk and terminal timing. Without it, replay compresses timing; when reproducing post-output transport failures, use timed replay so consumers have time to observe partial output before the socket closes. Timing alone does not reproduce an arbitrary concurrent scheduler. Replay transport failures close the HTTP socket rather than returning a synthetic clean EOF. A changed request gets HTTP 409 and no cassette bytes. Shutdown verifies that all interactions were consumed and exits nonzero for mismatch or incomplete consumption.

## Headless Rust record/replay

The driver uses fresh databases, explicit fixture paths, and denies approvals. Start with a text-only scenario:

```sh
bun src/blackbox/cli.ts record-engine \
  --bundle /private/path/rust.json --binary /path/to/miao-engine \
  --workspace /path/to/disposable-fixture --db /private/path/record.db \
  --upstream https://api.example.test/v1/chat/completions \
  --model MODEL --prompt "Say hello"

bun src/blackbox/cli.ts replay-engine \
  --bundle /private/path/rust.json --binary /path/to/miao-engine \
  --workspace /path/to/disposable-fixture --db /private/path/replay.db --timing
```

The default driver protocol is OpenAI Chat; the lower-level proxy also preserves other HTTP response formats as bytes. Engine-event IDs are correlated only in documented fields: run, input, checkpoint, message, engine call, and provider call identities. Tool arguments and arbitrary strings are never rewritten. `provider.failed` trace entries retain failure presence rather than potentially sensitive transport diagnostics; the HTTP interaction retains the transport outcome. Recording times stay in provenance and are not treated as equal across independent executions.

## Inspect and compare

```sh
bun src/blackbox/cli.ts inspect --bundle /private/path/provider.json
bun src/blackbox/cli.ts compare \
  --expected /private/path/ts.json --actual /private/path/rust.json
```

`inspect` lists boundary outcomes without dumping prompts or response bodies. `compare` exits 0 for equality and 1 for a difference. A report contains channel, lane, ordinal, JSON path, expected value, and actual value. Optional `--recorded-time` compares trace recording times, including unknown versus known.

HTTP bundles compare provider-native requests/responses between engines. TS semantic LLM bundles and Rust raw event bundles use different representations: do not treat direct equality between them as a product parity claim. Cross-engine product-history normalization is a separate adapter gate; retain missing historical model/agent identity as unknown rather than substituting current configuration.

## Verification

Core tests exercise tape integrity, private permissions, request poisoning, unconsumed interactions, partial output and classified transport failures, local tool suppression, and first-difference reports. A real Session-runner test records a two-turn tool flow, removes its file side effect, replays it, checks the same projected history, and verifies zero live provider calls and no repeated file write.

HTTP tests exercise recording/offline replay, mismatched requests, and a partial response followed by a broken socket. With `MIAO_ENGINE_BIN`, the sidecar test records a real Rust run, stops the upstream, replays provider bytes and correlated engine events against a fresh store, and deliberately changes the prompt to prove mismatch detection. The `session blackbox` CI workflow builds the sidecar and requires that test to run.
