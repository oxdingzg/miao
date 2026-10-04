# Remote Control Hub

The Hub forwards opaque ciphertext between a locally running Agent and remote clients. Model execution, project access, permission decisions, and Grant verification belong to the Agent. A connected WebSocket alone does not authorize access to a session.

Each configured host has a private bearer credential used only in its outbound WebSocket authorization header. Each connection receives a new routing identity. Losing the Agent connection disconnects that host's clients; clients must reconnect and resynchronize. The Hub does not retain frames or session history.

## Run

Create a private configuration file outside the checkout:

```json
{
  "hosts": {
    "<host-identity-at-least-16-characters>": "<random-secret-at-least-32-characters>"
  },
  "origins": ["https://control.example.com"]
}
```

Host identities contain only letters, digits, hyphens, and underscores. Use a cryptographically random secret, restrict configuration permissions, and never commit it. Browser origins must be explicitly allowed. Native clients may connect without an Origin header; application authorization still happens at the Agent.

```sh
MIAO_HUB_CONFIG=<private-config-file> bun --cwd packages/remote-control hub
```

The development listener defaults to loopback port 4600. Put a TLS reverse proxy in front of it for Internet access; it must support WebSocket upgrades. Both the Agent and clients initiate outbound connections, so the computer running miao does not need an inbound port mapping. DNS and an optional ingress proxy do not replace the Hub process.

## Container

Bundle from the repository root after installing workspace dependencies:

```sh
bun build packages/remote-control/src/hub-main.ts --target=bun --outfile=packages/remote-control/dist/hub.mjs
docker build -t miao-control-hub:preview packages/remote-control
```

Mount the private configuration read-only at `/config/hub.json`. Publish the container port only on the interface used by the reverse proxy. The container runs as an unprivileged user and needs no writable persistent storage. Run it with a read-only root filesystem, dropped capabilities, and `no-new-privileges`.

## Protocol and limits

- `/health`: liveness and protocol version only.
- `/v1/host?hostID=…&runtimeID=…`: authenticated Agent WebSocket. One connection per host.
- `/v1/client?hostID=…`: client WebSocket. The Hub notifies the Agent of a newly allocated connection identity.
- Clients send base64 ciphertext; Agents receive `{type: "frame", connectionID, payload}`. Agents reply with the same envelope; clients receive ciphertext only.
- `connected` and `disconnected` notifications contain routing metadata only.
- An authenticated Agent can send `{type: "close", connectionID}` to reject one of its own clients. It cannot close another host's client.

Defaults are 64 clients per host, 256 KiB per incoming frame, 1 MiB buffered output, and a 90-second idle timeout with WebSocket pings. Slow consumers reconnect instead of accumulating unbounded memory. Invalid routing frames close the sender. Cross-host routing is never allowed.

Shutdown force-closes active sockets and bounds the listener drain wait. Bun 1.3.14 has a [known server-side WebSocket close issue](https://github.com/oven-sh/bun/issues/36223) that can otherwise leave its drain promise pending.

## Agent and device grants

`DeviceGrants.load(<private-file>)` persists a stable host signing identity and owner-approved, public-key-bound grants. Open it once, inside the Runtime's exclusive storage ownership. Owner administration creates explicit project/session scopes, permission sets and expiration times. Revocation increments a durable version. Private files are bounded, atomically replaced and flushed, with Unix owner/mode checks. Invalid existing storage fails closed instead of replacing the host identity. A failed mutation disables authorization until the store is reopened successfully.

`ControlAgent.connect()` authenticates one outbound host connection, recovers it with bounded randomized backoff, and verifies locally approved device keys before accepting the signed E2EE handshake. Every structured request binds the host, Runtime, grant/version and optional project/session. Write requests require a stable UUID operation ID. The explicit method allowlist excludes provider credentials, arbitrary HTTP forwarding, connector administration and Runtime shutdown. There is no device auto-trust.

The host supplies scoped session handlers and authoritative session-to-project lookup. List handlers must filter by the supplied grant; handlers must recheck `context.authorize()` after waits and immediately before admission or disclosure, and honor cancellation before dispatch. Prompt/create idempotency, authoritative operation receipts, replay and pending-request semantics belong to these Runtime handlers, not to a transport retry. The Agent never automatically retries a business request after losing its connection. Permanent permission policy changes are not among the granted capabilities.

Agent limits include a 10-second unapproved handshake window, 8 queued requests and 512 KiB pending input per client, plus an 8 MiB response ceiling. Larger results are split into ordered encrypted 64 KiB chunks, without silently truncating history. Expired grants are checked on dispatch and periodically close live channels; owner revocation immediately aborts matching connections and queued requests. Closing the Agent only closes transport resources.

See [the RPC contract](RPC-PROTOCOL.md) for native/web client integration. Runtime composition, interactive pairing, directory authentication, replay and user interfaces are separate delivery steps; the Hub alone is not a usable remote session client.
