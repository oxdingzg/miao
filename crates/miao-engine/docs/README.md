# miao-engine documentation

Design records for the Rust engine. See `../README.md` for the capability
overview and `../PROTOCOL.md` for the stdio wire contract.

- [roadmap.md](roadmap.md) — unified goals, implementation status, task-efficiency work, priorities and release gates (中文).
- `inventory.md` — capability coverage and implementation evidence; progress and priorities are maintained in `roadmap.md`.
- `client-contract.md` — the product HttpApi/event surface a migration façade must cover.
- `handler-migration.md` — the B1 façade construction plan: which handlers move to the engine.
- `event-bridge.md` — mapping engine committed events onto product session events.
- `facade-mapping.md` — engine tool/event names the product compatibility facade maps from.
- `live-eval.md` — M4 gate evidence: live-eval vs the TS baseline and the rollback drill.
- `measurements.md` — binary size, `serve` readiness and RSS, with conditions and repro.
- `accuracy.md` — 产品结果、golden、随机不变量、参考差分及故障注入的运行与审阅方式。
- `adr/0001-runtime-ownership.md` — process/store ownership, coordinator, slots.
- `adr/0002-durability.md` — inbox/event/projection, tool lifecycle, recovery.
- `adr/0003-wire-replay.md` — adapter model, cursors, snapshot, subscriber lag.
- `adr/0004-authority.md` — permission, approval binding, sandbox profile.
- `adr/0005-extension-compatibility.md` — MCP, hooks, compatibility worker.
- `adr/0006-provider-semantics.md` — opaque reasoning, fallback, usage, credentials.
- `adr/0007-http-acp-adapters.md` — HTTP/ACP wire, revision negotiation, network authority.
- `adr/0008-delivery-and-migration.md` — sidecar→replacement migration; M4 delivery.
- `adr/0009-credential-refresh-ownership.md` — one refresh owner; read-only until sole runtime.
- `adr/0010-extension-worker-scope.md` — the M3 compatibility worker boundary.
- `adr/0011-client-contract.md` — where compatibility sits; the direct-replacement shape.
- `adr/0012-extension-worker-interface.md` — M3 worker transport, handshake and capability names.
