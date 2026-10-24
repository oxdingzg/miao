# 2026-10-24 engine functional conformance suite (TypeScript runner vs Rust engine)

`script/engine-conformance.ts`: 12 structural scenarios × 2 engines (24 cells), single pass per cell, model `zhipuai-coding-plan/glm-5.3-flash`; the vision pair (`image-input`) pins `zhipuai-coding-plan/glm-4.6v`. Every cell runs in a fresh temp workspace through `miao run --format json`; rust cells place the native engine via `MIAO_ENGINE_STORAGE` (credentials from the operator environment), ts cells delete it. Assertions are structural only — a tool executed, a file changed, a sqlite row exists — never the exact reply text. Raw evidence (redacted stdout JSONL, stderr, per-cell result) lives in `raw/`; the machine-readable summary is `results.json`.

## Matrix (final state, after the fixes below)

| scenario              | TS     | RS     | TS cost | RS cost | TS turns | RS turns | TS wall (s) | RS wall (s) |
| --------------------- | ------ | ------ | ------- | ------- | -------- | -------- | ----------- | ----------- |
| tool-recall           | PASS   | PASS   | 0.0012  | 0.0008  | 2        | 2        | 7           | 15          |
| file-edit             | PASS   | PASS   | 0.0017  | 0.0018  | 3        | 4        | 11          | 26          |
| apply-patch           | PASS   | PASS   | 0.0034  | 0.0018  | 4        | 4        | 13          | 21          |
| multi-turn-retention  | PASS   | PASS   | 0.0012  | 0.0009  | 2        | 2        | 13          | 18          |
| forced-compaction     | PASS ¹ | PASS   | 0.0056  | 0.0036  | 5        | 4        | 18          | 57          |
| interrupt-recovery    | PASS   | PASS   | 0.0023  | 0.0026  | 4        | 5        | 34          | 80          |
| background-job        | PASS   | PASS   | 0.0039  | 0.0022  | 5        | 4        | 21          | 32          |
| mcp-fixture           | PASS   | PASS   | 0.0023  | 0.0011  | 2        | 2        | 11          | 15          |
| permission-deny       | PASS   | PASS   | 0.0036  | 0.0020  | 4        | 4        | 23          | 35          |
| usage-priced          | PASS   | PASS   | 0.0007  | 0.0004  | 1        | 1        | 4           | 8           |
| session-title         | **FAIL** ² | PASS | 0.0016  | 0.0004  | 1        | 1        | 6           | 10          |
| image-input (4.6v)    | PASS   | PASS   | 0.0000 ³ | 0.0000 ³ | 1       | 2        | 7           | 17          |

**23/24 PASS, total spend $0.0917.** Fallback models were not needed (the primary credential stayed healthy; `openai/gpt-6.1-sol` does not exist in the catalog — the planned fallback list would have used it verbatim and failed).

¹ TS asserts completion only; the compaction-row assert is rust-only (tsEquivalent n/a). RS: `engine_compaction` rows = 1 with `MIAO_CONTEXT_LIMITS={"window":4000,"ratio":0.6,"headroom":1000,"perPass":2}`.
² Known limitation, not fixed (see defects #5): TS titles are a fire-and-forget fiber, and an ephemeral `miao run` usually exits before it lands. Interactive sessions are unaffected.
³ `glm-4.6v` has no catalog price entry, so both engines report $0.0000 — the known unpriced-model limitation, recorded as pass.

## Defects found → dispositions

| # | Defect | Hit | Layer | Disposition |
| - | ------ | --- | ----- | ----------- |
| 1 | Bridge projected engine tool ids onto vocabulary the product does not have: `apply_patch` → `apply-patch` (product tool, tui and session-ui all key on `apply_patch`), the job family collapsed into an invented `background-job` id, engine MCP aliases fell back to `custom` | rust | product (`packages/miao/src/engine/bridge.ts`) | **Fixed** `cb3b8bdbb3` — real product ids, MCP digest suffix stripped, `start_job` argv translated to `bash` + `run_in_background` |
| 2 | `translateCompaction` emitted payloads that fail the OpenCodeEvent schema (`{status}` with no sessionID/timestamp; ended without text/recent), so every compacted native session failed journal replay: `session.context` returned a ConflictError and `miao run` exited 1 after a fully successful turn | rust | product (`bridge.ts`) | **Fixed** `61f052208d` — `pre_compact` → valid `compaction.started`, `history.compacted` (carries the summary) → valid `compaction.ended` |
| 3 | `native.title` pulled `LLMClient.Service` from the location runtime context, where the global node never appears — Context.get always failed with "Service not found", so native sessions never generated titles | rust | product (`packages/miao/src/engine/native-engine.ts`) | **Fixed** `c9ebac331f` — client taken from the layer build context (`llmClient` joins the NativeEngine node deps) |
| 4 | Local `--file` attachments kept `file://` URLs; openai-chat media requires inline base64, so vision prompts failed on the TS runner ("media must contain valid base64") | ts | product (`packages/miao/src/cli/cmd/run.ts`) | **Fixed** `b0fe7a7808` — regular files are inlined as base64; local directories keep their `file://` URL |
| 5 | TS title generation is a fire-and-forget fiber; ephemeral headless runs exit before it lands, so `miao run` sessions keep the default title | ts | product design tradeoff | **Open, documented** — not a broken feature (interactive sessions title fine); a fix would need the headless wait path to await the title fiber |
| 6 | Engine MCP aliases truncate server names to 12 / tool names to 14 chars, so longer MCP tools project with truncated ids (only the digest suffix is strippable client-side) | rust | engine (Rust alias format) | **Open, documented** — a faithful projection needs an engine-side alias→identity map; local cargo builds are blocked by guard, not attempted |

Suite-side corrections (scenario/script layer, folded into the suite commit): the mission's `MIAO_ENGINE_CONTEXT_LIMITS` env name is wrong — the product reads `MIAO_CONTEXT_LIMITS` (`packages/miao/src/engine/native-engine.ts`); `miao run` yargs swallows the positional that follows `--file …`, so the prompt must precede attachments; the engine refuses MCP/policy config files inside the model-writable workspace, so the scenario writes them next to it and points `MIAO_ENGINE_MCP_CONFIG`/`MIAO_ENGINE_POLICY` there (the documented operator path — project-level MCP is by design never forwarded to the engine); the built-in title agent model (`glm-5.3-highspeed`) is not part of this subscription (429), so the scenario pins `agents.title.model` in project config to test the pipeline rather than that choice.

## How to run

```
source ~/.config/miao/engine-on.sh
bun script/engine-conformance.ts [--binary miao-dev] [--models a/b,c/d]
    [--scenarios id,id] [--engines ts,rust] [--storage DIR] [--data DIR]
    [--max-cost 3] [--segment-timeout 420]
```

Evidence per cell: `raw/<scenario>.<engine>.<model>.jsonl` (segment markers + the redacted event stream), `.stderr.txt`, `.result.json` (assert outcome, sessionID, cost, tokens, tool calls), `.workspace.txt` on failure. Secrets from the engine credential environment (credential db/id/integration, endpoint, storage root, routes config) are replaced with `[redacted]`; `sk-`/`Bearer` values are scrubbed. Failing cells keep a workspace dump. `results.json` holds the merged matrix across the three runs (run 1 + two fix-verification reruns; superseding evidence overwrites the same filenames).
