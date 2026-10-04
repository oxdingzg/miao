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

Defaults are 64 clients per host, 256 KiB per incoming frame, 1 MiB buffered output, and a 90-second idle timeout with WebSocket pings. Slow consumers reconnect instead of accumulating unbounded memory. Invalid routing frames close the sender. Cross-host routing is never allowed.

Shutdown force-closes active sockets and bounds the listener drain wait. Bun 1.3.14 has a [known server-side WebSocket close issue](https://github.com/oven-sh/bun/issues/36223) that can otherwise leave its drain promise pending.

This package currently supplies the transport foundation. Agent encryption, pairing, Grants, replay, and user interfaces are delivered separately; the Hub alone is not a usable remote session client.
