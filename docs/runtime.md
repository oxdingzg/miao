# Window-owned local runtime

Each normal `miao` invocation owns its UI, execution, local API and service scopes.
Closing its terminal or exiting miao ends that invocation's tasks and remote
connection. `miao run` cleans up when the command finishes; ACP cleans up on
stdio EOF. Background tasks, pending inputs and schedules do not keep a window
alive. A forced process kill cannot execute graceful cleanup.

Independent windows share durable history in SQLite WAL. They can execute
different Sessions concurrently. A window claims a Session before its first
mutation or explicit continuation and retains that claim until it exits,
including while idle. Another window can read its history, but attempts to
continue or change it fail with a clear ownership error (HTTP 409). Closing the
owner releases the claim. Reopening does not automatically retry interrupted
model calls, tools or pending inputs; continue explicitly.

Database schema changes and destructive maintenance require exclusive storage
access. If another window is using that database, close it before performing
maintenance or applying an incompatible schema change. A newer window never
stops another window or falls back to its older execution code.

The local listener uses a fresh private credential and runtime ID for each
invocation. Its private registration file is
`<database>.runtime-<runtimeID>.json`. Registration identifies a particular live
window; it does not discover or reuse a global service. Do not publish these
files. The private `runtime access` bridge requires an explicit runtime ID and
never starts a runtime. The old `runtime start/status/stop/restart` commands are
removed.

Remote Control administration is initialized only when explicitly accessed,
for example through `/remote-control`; merely starting miao with saved remote
configuration does not establish an Agent connection. Its resources belong to
that window and are closed with it. The relay Hub is an independently deployed
service and does not execute or restart local Sessions.

`miao serve` is an explicit foreground API server. Keep its process running to
serve clients. `miao attach <url>` and `miao run --attach <url>` connect to an
explicitly selected server; closing an attach client closes its own connection.

Installing an update does not restart a running invocation. Existing windows
retain their loaded execution code; new windows load the installed build.
Source development runs read source files and do not provide an immutable code
snapshot across source edits. See the [implementation plan](../specs/window-runtime.md)
for remaining release and installation validation.
