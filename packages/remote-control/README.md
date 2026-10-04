# Remote Control Hub

The Hub forwards opaque ciphertext between a locally running Agent and remote clients. Model execution, project access, permission decisions, and Grant verification belong to the Agent. A connected WebSocket alone does not authorize access to a session.

In account mode, the Hub authenticates the owner, isolates the host directory by account, and verifies different credentials for Agents and clients. Agent-issued device grants still authorize session operations. Losing the Agent connection disconnects that host's clients; clients must reconnect and resynchronize. The Hub does not retain frames or session history.

## Run with account authentication

Create a private directory with mode `0700` and a configuration file with mode `0600`, both owned by the Hub process user, outside the checkout:

```json
{
  "mode": "account",
  "database": "hub.db",
  "baseURL": "https://control.example.com",
  "secret": "<cryptographically-random-secret-at-least-32-characters>",
  "migrate": true,
  "bootstrap": {
    "email": "owner@example.com",
    "password": "<private-password-at-least-12-characters>",
    "name": "Owner"
  }
}
```

Database paths are resolved relative to the configuration file. Existing storage must have owner-only permissions; symlink configuration/database files are rejected. `baseURL` is the public root HTTPS origin, without credentials, path or query. The listener defaults to loopback port 4600. The TLS reverse proxy must support WebSocket upgrades. Both the Agent and clients initiate outbound connections, so the computer running miao needs no inbound port mapping.

```sh
MIAO_HUB_CONFIG="<private-config-file>" bun --cwd packages/remote-control hub
```

`migrate: true` explicitly permits authentication and metadata schema migration. After initialization, remove `bootstrap` and set `migrate: false`. The bootstrap only creates the first administrator; it creates no login session and cannot overwrite an existing account. Open registration is disabled. Back up the SQLite database with SQLite's online backup mechanism before permitting an upgrade; do not copy a live database without its journals. Unknown metadata versions are rejected. Database rollback/restore and revalidation of revoked routing credentials require a separate maintenance procedure; copying an old backup is not a grant recovery mechanism.

The authentication framework stores accounts, login sessions, encrypted signing keys and rate limits in SQLite. Signed login credentials last up to seven days and can be renewed through `get-session`; ES256 access tokens last 15 minutes. Directory and client routing require access tokens. Logout invalidates those access tokens immediately on requests and closes idle client sockets within one second. Login throttling uses the socket peer address, ignoring untrusted forwarding headers; deployments through a proxy currently share that peer's login budget.

Agents register their stable host ID, public signing key and label through the authenticated directory. Registration returns a host credential once; only its hash is stored. Keep the credential in the Agent's private configuration. Credential rotation/revocation closes the old host connection. The returned signing key is directory metadata, not a substitute for the client's locally pinned host key or owner-approved pairing.

The older private development forwarder configuration (`hosts` plus optional `origins`) remains available for isolated transport probes. It does not provide account authentication or a directory; use account mode for the authenticated service.

## Container

Bundle from the repository root after installing workspace dependencies:

```sh
bun build packages/remote-control/src/hub-main.ts --target=bun --outfile=packages/remote-control/dist/hub.mjs
docker build -t miao-control-hub:preview packages/remote-control
```

Mount the private configuration read-only at `/config/hub.json`. For account mode, set its database path to `/data/hub.db` and mount an owner-only persistent directory at `/data`. Run as a non-root UID/GID matching the configuration and data owner (override the container user when needed). Publish the port only on the interface used by the reverse proxy. Use a read-only root filesystem, dropped capabilities, and `no-new-privileges`; only the metadata volume is writable. Keep the database backup and authentication secret private.

## Protocol and limits

- `/health`: liveness and protocol version only.
- `/v1/host?hostID=…&runtimeID=…`: authenticated Agent WebSocket. One connection per host.
- `/v1/client?hostID=…`: client WebSocket; account mode requires an access token in the authorization header. The host must belong to that account. The Hub notifies the Agent of a newly allocated connection identity.
- `/api/auth/sign-in/email`, `/api/auth/get-session`, `/api/auth/token`, `/api/auth/sign-out`: supported login, renewal, access-token and logout routes. Other authentication routes are unavailable.
- `/api/hub/version` and `/api/hub/hosts`: authenticated capabilities and account-scoped directory; `POST /api/hub/hosts` registers a host.
- `POST /api/hub/hosts/:hostID/rotate` and `/revoke`: account-scoped host-credential administration.
- Online status means a currently authenticated Agent connection exists. It does not prove Runtime readiness or active model execution.
- Clients send base64 ciphertext; Agents receive `{type: "frame", connectionID, payload}`. Agents reply with the same envelope; clients receive ciphertext only.
- `connected` and `disconnected` notifications contain routing metadata only.
- An authenticated Agent can send `{type: "close", connectionID}` to reject one of its own clients. It cannot close another host's client.

Defaults are 64 registered hosts and 64 live clients per account, 64 clients per host, 16 KiB per HTTP body, 256 KiB per incoming frame, 1 MiB buffered output, and a 90-second idle timeout with WebSocket pings. Slow consumers reconnect instead of accumulating unbounded memory. Invalid routing frames close the sender. Cross-host routing is never allowed.

Shutdown force-closes active sockets and bounds the listener drain wait. Bun 1.3.14 has a [known server-side WebSocket close issue](https://github.com/oven-sh/bun/issues/36223) that can otherwise leave its drain promise pending.

## Agent and device grants

`DeviceGrants.load(<private-file>)` persists a stable host signing identity and owner-approved, public-key-bound grants. Open it once, inside the Runtime's exclusive storage ownership. Owner administration creates explicit project/session scopes, permission sets and expiration times. Revocation increments a durable version. Private files are bounded, atomically replaced and flushed, with Unix owner/mode checks. Invalid existing storage fails closed instead of replacing the host identity. A failed mutation disables authorization until the store is reopened successfully.

`ControlAgent.connect()` authenticates one outbound host connection, recovers it with bounded randomized backoff, and verifies locally approved device keys before accepting the signed E2EE handshake. Every structured request binds the host, Runtime, grant/version and optional project/session. Write requests require a stable UUID operation ID. The explicit method allowlist excludes provider credentials, arbitrary HTTP forwarding, connector administration and Runtime shutdown. There is no device auto-trust.

The host supplies scoped session handlers and authoritative session-to-project lookup. List handlers must filter by the supplied grant; handlers must recheck `context.authorize()` after waits and immediately before admission or disclosure, and honor cancellation before dispatch. Prompt/create idempotency, authoritative operation receipts, replay and pending-request semantics belong to these Runtime handlers, not to a transport retry. The Agent never automatically retries a business request after losing its connection. Permanent permission policy changes are not among the granted capabilities.

Agent limits include a 10-second unapproved handshake window, 8 queued requests and 512 KiB pending input per client, plus an 8 MiB response ceiling. Larger results are split into ordered encrypted 64 KiB chunks, without silently truncating history. Expired grants are checked on dispatch and periodically close live channels; owner revocation immediately aborts matching connections and queued requests. Closing the Agent only closes transport resources.

See [the RPC contract](RPC-PROTOCOL.md) for native/web client integration. Runtime composition, interactive pairing, replay and user interfaces are separate delivery steps; the Hub alone is not a usable remote session client.
