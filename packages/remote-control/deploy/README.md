# Account Hub with a stable HTTPS tunnel

Build the Hub image using the package README. This Compose stack publishes no
host ports. The Hub runs as the private data owner; a Cloudflare connector can
reach it over the stack's private Docker network. Both containers use read-only
root filesystems, dropped capabilities and bounded logs.

Create an owner-only directory outside the checkout. Store the account-mode Hub
configuration, persistent data directory and tunnel token there. Set the Hub
configuration's `database` to `/data/hub.db`, `webDirectory` to `/app/web`, and
`baseURL` to the exact public HTTPS origin. Initialize its private administrator
as described in the package README. The configuration and database directory
must belong to the UID/GID used by the container, with modes 0600 and 0700.

Create a remotely managed Cloudflare Tunnel and publish that hostname with HTTP
origin `http://hub:4600`. Store its connector token as a 0600 file owned by the
same UID/GID. The connector uses `--token-file`, so the token stays out of
arguments and container environment variables. See Cloudflare's official
[setup guide](https://developers.cloudflare.com/tunnel/get-started/) and
[token-file option](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file).

Store these variables in a private environment file outside the checkout:

```dotenv
MIAO_HUB_IMAGE=miao-control-hub:preview
MIAO_HUB_UID=<data owner UID>
MIAO_HUB_GID=<data owner GID>
MIAO_HUB_CONFIG_FILE=<absolute private configuration filename>
MIAO_HUB_DATA_DIRECTORY=<absolute private data directory>
MIAO_TUNNEL_TOKEN_FILE=<absolute private tunnel token filename>
```

Run from the repository root, replacing the environment filename:

```sh
docker compose --env-file <private environment file> -f packages/remote-control/deploy/compose.yml config --quiet
docker compose --env-file <private environment file> -f packages/remote-control/deploy/compose.yml --profile cloudflare up -d
```

Verify the public HTTPS health endpoint, sign in, register a host, and exercise
an authenticated Agent/device WebSocket connection. Container health proves the
local Hub responds; it does not prove tunnel, account or encrypted session access.
Do not add a second browser-based Cloudflare login layer to this hostname unless
native and Agent clients are explicitly configured for it.

For upgrades, stop the Hub and save its configuration, secret and entire data
directory in private backup storage before changing the image. Keep the previous
image available. Restore all three together for rollback. Never copy a live
SQLite database file alone. Graceful Hub shutdown closes relay connections;
clients reconnect and query pending operations instead of replaying writes.
