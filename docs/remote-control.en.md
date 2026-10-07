# Remote Control

[简体中文](remote-control.zh.md)

Remote Control lets you use a running miao window from another device. The
window executes tasks locally; your own Hub relays encrypted traffic between
that window and the Web or iOS client. A Hub login alone does not grant access
to sessions: the local owner approves a device and the scope of its access.

## Before you connect

- Use a current miao build with `/remote-control` and a running local window.
- Deploy a Hub with account authentication and an HTTPS address. The repository
  contains [Hub setup and container instructions](../packages/remote-control/README.md)
  and a [Compose deployment](../packages/remote-control/deploy/README.md).
- Serve the Web client from that Hub's origin, or use a compatible iOS client.
  The Hub is separate from mtty.dev and is not a hosted service provided by this site.

The computer running miao makes an outbound connection to the Hub; Remote
Control does not require exposing the local API or mapping an inbound port.

## Connect a window and approve a device

1. Start `miao` in the project you want to work on and open `/remote-control`.
2. Use the dialog's setup flow to connect to your Hub and sign in. Saved
   configuration alone does not connect a newly opened window: explicitly
   enable access for that window.
3. Create an invitation with the project/session scope, allowed operations and
   expiration you intend to share. Open it in the remote client.
4. Confirm the candidate device key and scope in the local window before
   approving it. A transport connection is not automatic device trust.
5. Use the remote client's session list and controls within that grant. Access
   is limited to Sessions owned by the selected window, including Sessions
   created remotely there.

The dialog also lists pending pairings and approved devices. Reject an
unwanted pairing or revoke a device there. Revocation invalidates its grant
and closes its active channels. Turning off Remote Control closes this
window's connection while local work continues.

## What happens when a window closes

Each normal miao invocation owns its execution and remote connection. Closing
that window ends both; background tasks and queued inputs do not keep it alive.
Independent windows share durable history but retain separate execution
ownership and connections. A remote reconnect keeps its selected window target;
it does not silently move to a different window on the same machine.

Reopening history is not automatic execution recovery. Continue interrupted
work explicitly. See [Runtime lifecycle](runtime.md) for ownership, updates
and the private `runtime access` integration bridge.

## Explicit server access

`miao serve` is a separate foreground HTTP API server. `miao attach <url>` and
`miao run --attach <url>` connect to the server you select; these are distinct
from Hub/device pairing. Its listening interface and authentication are
configured separately. See [Security](../SECURITY.md).

## Migrating from the old IM bridge

The old WeChat/QQ bridges, `miao remote` CLI and `remote.*` configuration are
removed. `/remote` remains a compatibility alias for the new Remote Control
dialog, not the old IM bridge. Use `/remote-control` with your Hub and a paired
client. This is device-based remote access, not an IM bot migration;
old chat commands and bot accounts do not carry over.

## Troubleshooting

- **Host offline:** keep the selected miao window open and explicitly enable
  its Remote Control connection; verify that the Hub is reachable over HTTPS.
- **Connected but no access:** sign in to the correct Hub account, then check
  local device approval, scope and expiration. Hub login and device grants are
  separate requirements.
- **Session owned by another window:** use the connection for that owner, or
  close it before explicitly continuing the Session elsewhere.
- **Connection lost during a write:** inspect the Session before retrying.
  Reconnection does not automatically repeat business requests or tool effects.

Availability follows the installed build. Source-only UI changes may not yet
be in the latest release; check the release notes before using preview features.
