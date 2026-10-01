# miao Architecture and Roadmap (2026-Q4)

Status: proposal, 2026-10-01. Evidence: `docs/research/2026-10-01-miao-research-and-plan.html`
(local research report: user pain points, feature matrix, community feedback, sync architectures,
memory profile) and `docs/research/2026-10-01-zcode-teardown.md`.

## Goal

The product goal that drives every decision below: **a phone app for mtty with Claude-style
session sync** — start work on the desktop, follow, steer and approve it from the phone, and pick
it up anywhere, with any model provider.

## Where miao stands

Strengths to keep and amplify:

- Prompt-cache observability (warm/miss, TTL, Context Epoch) and native-currency cost with a
  budget stop — no other agent has these.
- V2 durable inbox: admission separate from execution, steer vs queue, per-Session serialized
  runner, per-aggregate event `seq` with replay (`GET /api/session/:id/event?after=`).
- Multi-provider including ChatGPT subscription (persistent Responses WebSocket) and Chinese token
  plans.

Debts that block the goal (measured 2026-10-01):

| Debt | Evidence |
|---|---|
| Two runtimes | V1 still serves `--mini`, ACP and legacy routes; `db compact` broke `--mini` and had to be undone |
| Heavy process | TUI RSS 1.3-1.5 GB (Codex 64 MB, Claude Code 184 MB); two JSC VMs with 1216 duplicated modules; full 6.6 MB models catalog shipped to the TUI at startup; gpt-tokenizer eager |
| ID wraparound | `packages/schema/src/identifier.ts` packs `ms * 4096` into 48 bits → wraps every 2^36 ms (≈795 days); last wrap 2026-08-14 (the upstream opencode outage), next 2028-10-17 |
| Remote-unready protocol | single global Basic password; global `/api/event` SSE has no ids and no resume; no writer fencing; no push |
| Test noise | ~25 tests fail on `main` (config, run-process, snapshots), hiding regressions |
| Sandbox off by default; bash permission bypasses (`cd`, pipes, heredoc, `env`) reported upstream |

## Target architecture

One kernel, one protocol, many clients.

```
 clients:  TUI · --mini · miao run · ACP · desktop/web · mtty mobile · IM bots (Feishu/WeCom/Telegram)
                          │  V2 protocol (commands + resumable event stream)
 kernel:   session runner · tools · permissions/sandbox · LLM transports · event store (SQLite)
 edge:     relay (E2E-encrypted envelopes, cursors, push) — optional, for off-VPN access
```

Principles (each has a measurable gate in the roadmap):

1. **Single runtime.** Everything on V2; V1 deleted; then `db compact` is safe.
2. **The protocol is the contract.** Every client, including the TUI, uses only the V2 protocol.
   Generated types for TS, Swift/Kotlin (via a Rust `miao-wire` crate) and the relay.
3. **Kernel runs as a daemon.** `miao serve` under launchd/systemd on a desktop or home server
   (macmini/dev over WireGuard); the local TUI attaches to it or embeds it.
4. **Load on demand.** Catalog, tokenizer, LSP, plugins, Babel, MCP start on first use.
5. **Event log is the sync unit.** Single writer per Session (epoch fencing); clients replicate
   read-only with cursors. No CRDT multi-writer.
6. **Safe by default.** OS sandbox on by default once bypasses are closed; escalations only by
   explicit rules (done in 0.0.31).
7. **Provider-native, cache-first.** Persistent/incremental transports where the provider has
   them; byte-stable prefixes; no volatile data (dates) in system prompts.

## Protocol work required for remote/mobile clients

| Capability | Today | Needed |
|---|---|---|
| Auth | one Basic password (`packages/server/src/auth.ts`) | device pairing: one-time QR → per-device revocable token with scopes (read / approve / write); device list |
| Global stream | `/api/event` SSE, no `id`, live only, 256-slot queue | every event `id: <aggregate>:<seq>`; `Last-Event-ID` or multi-session cursor subscribe; gap detection → "resync" signal |
| Writer fencing | process-local coordinator | epoch/lease per Session; explicit takeover close reason (like Claude's 4090 / 409 epoch) |
| Approvals | `permission.v2.asked` live | durable request events, first reply wins, timeout policy, push hook |
| Handshake | none | `initialize`: protocol version, capabilities, client presence |
| Attachments | blob storage exists | content-addressed upload, chunked/resumable, referenced by hash in prompts |
| Push | none | kernel notifier (approval needed, turn ended, error) → relay → APNs/FCM; minimal or encrypted payload; suppressed when a desktop client is present |

## Roadmap

Each phase ships on its own; each has a gate that must pass before the next starts.

### Phase 0 — Stabilize (≈2 weeks)

- Fix ID wraparound: widen the time field (or store time and counter separately) with a migration
  that keeps sort order across the 2026-08-14 boundary; test across a simulated wrap.
- Memory/startup P0–P1 (from the profile): TUI fetches only connected providers (full catalog on
  demand); `/command` without skill bodies; lazy `Token.count`, turndown, Babel/solid transform;
  `Database.path()` in a light module; logo animates colors without rebuilding nodes.
- Make `main` green: fix or quarantine the ~25 known failures with owners.
- Publish a baseline in README: startup to prompt, idle RSS, idle CPU, crash-recovery result.
- Gate: idle RSS < 600 MB, startup to prompt < 2.5 s, idle CPU < 1 %, all tests green.

### Phase 1 — Single runtime (≈3–4 weeks)

- `--mini` and ACP on V2 (ACP behind an isolated adapter module that talks only V2 — the seam a
  Rust `miao-acp` could later replace).
- Delete V1 session/runtime code and unused upstream packages (web, console, enterprise, stats,
  function, slack, infra, sdks/vscode unless adopted).
- Then compact the daily database (backup, clone smoke test of every entry point first).
- Gate: no imports of `packages/miao/src/session`; `--mini`, ACP (Zed) and `export` pass e2e on a
  compacted clone.

### Phase 2 — Remote-ready kernel (≈3 weeks)

- Daemon mode, device pairing auth, resumable global stream, writer fencing, durable approvals,
  `initialize`, attachments, notifier hook (table above).
- Gate: a scripted client survives kill/restart of the network and the kernel with no lost or
  duplicated events; approvals answered remotely; protocol documented and versioned.

### Phase 3 — mtty mobile MVP (≈4–6 weeks)

- iOS first, native SwiftUI, over WireGuard to the daemon (the user's wg-office).
- Multi-agent inbox ("who is waiting on me"), session list/history, live stream, prompt, image
  attach, dictation, approve/deny, interrupt, diff view; a terminal tab per session via SwiftTerm.
- Structured UI only — never scrape terminal output (Omnara abandoned that approach).
- Gate: reconnect < 3 s after network switch; zero missed approvals in a 1-day soak.

### Phase 4 — Relay, E2E, push, IM (≈3–4 weeks)

- Rust relay (axum + tungstenite) that stores and forwards encrypted envelopes with cursors;
  kernel dials out; QR pairing with X25519 + AES-GCM (pattern of Happy / Remodex); APNs.
- IM clients on the same protocol: Feishu, WeCom, Telegram bots.
- Gate: relay cannot read content (verified); push latency < 5 s.

### Phase 5 — Feature parity and differentiators (rolling, parallel to 2–4)

Table stakes miao lacks: productized `/rewind` (code + conversation), config shell hooks,
named permission modes, sandbox default-on after closing bypasses, `/goal` object (pause/resume,
budget, survives restart), input UX (paste expand, Shift-Enter, Ctrl-C interrupts), Chinese TUI.

Differentiators: usage explainer ("why did this burn quota": per-turn cache rebuilds and context
growth, quota forecast); multi-account profiles with subscription → API → cheaper-provider
failover on 429/quota; Chinese coding-plan presets with reasoning/thinking field normalization;
cache-friendly harness audit published with numbers; session import from Claude Code/Codex.

Not doing: Claude/Google subscription OAuth in third-party clients (ToS risk; opencode removed it);
CRDT multi-writer sync; terminal scraping.

## Where Rust fits

1. `miao-wire` (with Phase 2): protocol types, E2E crypto, cursor/replica logic — shared by the
   relay and the mobile apps through UniFFI. Types generated from the V2 Effect Schema.
2. The relay (Phase 4).
3. Tool layer pieces already native (sandbox, edit) and the LLM transports.
4. The session kernel last, behind the unchanged protocol (Codex's `ThreadStore` + app-server
   layering as the template).

The profile shows a Rust kernel would cut the server VM (~200 MB live heap, ~1.5 s import, ~1 s
instance boot) but not the TUI VM; reaching Codex-level footprint needs the TUI rewritten too.
Phase 0 recovers most startup CPU and peak memory in TypeScript first.

## Open decisions

1. iOS first (recommended) or Android/both via React Native?
2. Relay hosting: own VPS (recommended for E2E control) vs WireGuard-only for now.
3. IM priority: Feishu vs WeCom vs Telegram.
4. When to flip the sandbox and the ChatGPT persistent WebSocket on by default.
5. Pricing stance for the mobile app (community dislikes subscriptions for clients; one-time or free).
