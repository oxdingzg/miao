# miao-engine documentation

Design records for the Rust engine. See `../README.md` for the capability
overview and `../PROTOCOL.md` for the stdio wire contract.

- `inventory.md` — capability coverage and current status.
- `adr/0001-runtime-ownership.md` — process/store ownership, coordinator, slots.
- `adr/0002-durability.md` — inbox/event/projection, tool lifecycle, recovery.
- `adr/0003-wire-replay.md` — adapter model, cursors, snapshot, subscriber lag.
- `adr/0004-authority.md` — permission, approval binding, sandbox profile.
- `adr/0005-extension-compatibility.md` — MCP, hooks, compatibility worker.
- `adr/0006-provider-semantics.md` — opaque reasoning, fallback, usage, credentials.
