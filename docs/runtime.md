# Persistent local Runtime

> Transition notice (2026-10-06): this page documents the currently implemented
> shared Runtime. The accepted replacement is a runtime owned by each CLI
> invocation: closing its window ends its execution and Remote Control, and new
> windows execute the newly installed build. See the
> [design and implementation schedule](../specs/window-runtime.md). That change
> has not shipped; do not read the plan as current command behavior.

The default TUI, `miao run`, and `miao --mini` connect to a persistent local
Runtime. The first client starts it in the background. Closing the interface
does not terminate other clients or running sessions. Ctrl-C in a headless run
interrupts the observed execution, using its identity so a delayed request
cannot interrupt a successor.

The Runtime hosts the session API and the outbound Remote Control Agent.
`/remote-control` configures a self-hosted relay and authorizes App/Web devices
against the attached Runtime. Legacy WeChat/QQ connectors, their local session
Router, the IM daemon and the `miao remote` command have been removed. Existing
IM account files are left on disk but are no longer loaded or used.

```sh
miao runtime status
miao runtime stop
miao runtime start  # foreground; useful for service supervisors
```

`miao attach <url>` continues to connect to an explicitly selected server.

Each persistent database has one OS ownership lock. All normal database
initialization acquires it before opening or migrating storage. Service scopes
inside the same process share a lease; another process cannot bypass the owner.
Maintenance commands that need their own database writer require stopping the
Runtime first. Explicit network listeners also cannot become a second owner.

The listener binds to loopback and generates a private random administrator
credential. Its adjacent `.runtime-info.json` file is written atomically with
private permissions. Clients verify a challenge response bound to the process,
storage, version, and listener address before authenticating. Logs are written
to the adjacent `.runtime.log` file. Never publish these files.

Software releases and the Runtime wire protocol have separate versions. Clients
can share an authenticated Runtime from another software release when its wire
protocol is supported. Upgrading replaces the installed program; it does not
stop the Runtime, disconnect other windows, or interrupt their tasks. Existing
windows keep their loaded build, and newly opened windows use the installed
build while connecting to the same compatible Runtime.

The shared Runtime keeps its loaded execution code until it is restarted. This
is independent of the client version; `miao runtime status` displays the Runtime
release and protocol. To apply Runtime changes, finish active tasks, run
`miao runtime stop`, and open miao again. The stop command works across software
versions, verifies the owner's identity, and waits for storage ownership to be
released. Automatic upgrades never restart a running owner.

Startup configuration remains owned by the Runtime. Changing
`MIAO_CONFIG_CONTENT` requires stopping that Runtime first; a new client cannot
silently replace another session's configuration. A graceful stop
interrupts active execution, closes Agent channels and service scopes, removes
discovery information, then releases storage ownership. Restarting preserves
session history but does not automatically repeat interrupted provider or tool
work.

# ACP clients

`miao acp` uses the same persistent Runtime by default. Closing the editor's
stdio connection closes the adapter, while the Runtime retains ownership of
its sessions. `--attach <server URL>` selects an existing endpoint; explicit
network options retain the foreground server mode. A foreground server and a
Runtime cannot own the same on-disk storage at the same time.

# Outbound Remote Control Agent

Set `MIAO_REMOTE_CONTROL_CONFIG` to an owner-only configuration file to attach
the Runtime to a Hub. On Unix, the file must belong to the current user and have
no group or other permissions. Keep this file and its credentials outside the
checkout:

```json
{
  "hubURL": "https://<hub-host>",
  "hostToken": "<host credential of at least 32 characters>",
  "grantFile": "devices.json"
}
```

The grant file is resolved relative to the configuration file. It stores the
stable host identity and locally approved device grants. Register that host ID
and credential with the Hub. Remote requests cannot approve devices or modify
the host configuration. HTTPS is required; `allowLoopbackHTTP: true` permits
HTTP only on loopback for local verification.

The Agent currently exposes capabilities, authorized project and Session lists, Session reads, paginated durable
history, pending inputs/permissions/questions, diffs, text prompt admission and
operation receipt lookup, and Session creation in registered project directories. Project listing returns opaque directory IDs; Session creation accepts an ID instead of a filesystem path. Exact create retries adopt the same Session and do not start execution. This is the Runtime transport integration; device
pairing UI and the remaining client flows are separate work.

Prompt retries use one stable operation ID. The Runtime persists a receipt
before admission, rejects changes to that operation's content or target, and
checks durable input records before sending another admission request. An input
already admitted is acknowledged without waking its execution again. Disconnecting
the remote transport does not interrupt execution. Stopping the Runtime closes
the Agent before shutting down its execution services.

Remote mutations also support Session renaming, interruption by observed
execution ID, one-time permission acceptance/rejection, and question answers or
rejection. Remote permission replies cannot install a permanent policy. Each
mutation uses a stable operation ID and an immutable receipt. If a crash leaves
a prepared mutation without a confirmed result, its retry reports
`outcome_unknown` instead of automatically repeating the action. Refresh the
Session's pending state before deciding whether another action is needed.

`session.events` accepts an exclusive durable `after` cursor, a page limit up to
100, and `waitMs` from 0 to 1000. It returns an ordered page, `hasMore`, and the
last delivered durable cursor. The local replaying event stream closes the gap
between checking history and waiting for an update. Clients persist the returned
cursor only after applying the complete page, then request the next page; an
empty response retains the previous cursor. A short bounded wait keeps other
operations responsive on the same connection.

`selection.list` requires an authorized Session or registered project directory.
It returns selectable agent and model metadata without provider settings,
request headers, or agent system prompts.

# Local pairing administration

The Runtime's authenticated local API controls device pairing. These endpoints
require the local administrator credential and are excluded from remote device
RPC, even for grants that can submit prompts or answer tool approvals.

| Method and path                                        | Operation                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /api/runtime/control`                             | Inspect host identity and Hub connection status                               |
| `POST /api/runtime/control/invitation`                 | Issue a short-lived invitation for registered project or Session IDs          |
| `GET /api/runtime/control/pairing`                     | Inspect candidate device keys and proposed scopes, without invitation secrets |
| `POST /api/runtime/control/pairing/:pairingID/approve` | Confirm the exact candidate public key                                        |
| `DELETE /api/runtime/control/pairing/:pairingID`       | Reject or cancel the invitation                                               |
| `GET /api/runtime/control/device`                      | Inspect persistent device grants and revocations                              |
| `POST /api/runtime/control/device/:grantID/revoke`     | Revoke the observed grant version and close its live channels                 |

Invitation payloads specify `permissions`, `projectIDs`, `sessionIDs`, and
`expiresAt`. The Runtime validates those scopes against its registered projects
and existing Sessions. Approval supplies `publicKey`; revocation supplies
`version`. Clients obtain the wire types and methods from the generated SDK's
`server.runtime` group. Pairing UI and client scanning are separate integrations;
the API does not require stopping the running Session.

# Desktop integration over a private pipe

Desktop clients can run `miao runtime access` with one JSON request on stdin,
close stdin, and read one JSON response on stdout. This command discovers and
attests an existing Runtime; it never starts a second Runtime. Keep stdout in
an application-owned pipe rather than a terminal transcript or diagnostic log.
Invitation responses contain a short-lived pairing secret. Send relay passwords
only through stdin, never command arguments or environment variables.

```json
{ "version": 1, "method": "status" }
```

Successful responses contain `version: 1`, `ok: true`, `runtimeID`, and `data`.
Use the returned Runtime ID on every subsequent request. An optional `storage`
field selects the attached session's database; omitting it selects the CLI's
normal database. Do not silently fall back to a different database or Runtime
when a pane refers to an explicit remote server.

| Method    | Additional request fields                          | Result in `data`                      |
| --------- | -------------------------------------------------- | ------------------------------------- |
| `status`  | Optional `runtimeID`                               | Host identity and connection status   |
| `session` | `runtimeID`, `sessionID`                           | Session ID, project ID and title      |
| `invite`  | `runtimeID`, `policy`                              | Pairing invitation                    |
| `pending` | `runtimeID`                                        | Invitations and candidate device keys |
| `approve` | `runtimeID`, `pairingID`, `publicKey`              | Approved device grant                 |
| `reject`  | `runtimeID`, `pairingID`                           | `null`                                |
| `devices` | `runtimeID`                                        | Device grants, including revocations  |
| `revoke`  | `runtimeID`, `grantID`, `grantVersion`             | Revoked grant                         |
| `setup`   | `runtimeID`, `hubURL`, `email`, `password`, `name` | Updated connection status             |

`policy` has the same fields as the local invitation API. Present its scopes
before creating an invitation, confirm the exact candidate public key before
approval, and revoke only the version observed in `devices`. Relay setup accepts
an HTTPS origin and stores only the host-scoped relay credential in private
Runtime configuration; the account login is signed out after setup.

Failure responses contain `ok: false` and a fixed `error` code:
`invalidRequest`, `noRuntime`, `runtimeChanged`, `unavailable`, or `unconfirmed`.
They do not forward provider errors, credentials, or input values. On
`runtimeChanged`, discard pending actions and refresh the selected Runtime.
On `unconfirmed`, a mutation may have taken effect: inspect pairing, device,
or connection status before deciding on a new action. Never automatically
repeat an uncertain approval, revocation, or relay setup.

Input must be a single JSON object with known fields, at most 64 KiB, received
with stdin closed within five seconds. Local API requests have a 15-second
network deadline and reject redirects. Relay setup makes several individually
bounded requests; the desktop caller must allow that flow to settle before
retrying. This bridge supplies administration operations; the desktop UI is a
separate integration.

# Terminal pane identity

When running inside mtty, each observing TUI reports its visible Session and
activity through the pane's local CLI. The report includes an owned Runtime ID
and storage selector for the normal persistent Runtime, or an explicit attached
server marker for other endpoints. Returning home clears the visible Session;
exiting clears the binding. Reports are serialized and pending changes are
coalesced, so an older update cannot overtake a newer one.

The shared background Runtime does not inherit a launching client's pane ID.
It cannot act as the state reporter for every TUI that later connects to it.
Runtime identity metadata is sent through a private pipe using
`mtty-cli state --runtime-context -`; it contains no administrator credential.
Older terminal CLIs continue to receive the basic state and Session fields.
A desktop connection UI must validate the reported owned Runtime and reject
attached or missing context instead of choosing the default local Runtime.
