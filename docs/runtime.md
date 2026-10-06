# Window-owned local runtime

Each normal `miao` invocation owns its UI, execution, local API and service scopes.
The TUI and local runtime share one process; there is no execution Worker or daemon.
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
that window and are closed with it. Use the dialog to enable or disable access for
this window. Disabling closes its Agent, pairing, notifications and subscriptions
while local execution continues. Remote reads and mutations are limited to
Sessions owned by that invocation, including Sessions created remotely there.
Other windows may enable their own connections independently. Web/iOS reconnects
keep their explicit window target; they never switch to a different window just
because it shares the same host identity. Device grants and revocations are
shared durably without losing simultaneous approvals. The relay Hub is an independently deployed
service and does not execute or restart local Sessions.

`miao serve` is an explicit foreground API server. Keep its process running to
serve clients. `miao attach <url>` and `miao run --attach <url>` connect to an
explicitly selected server; closing an attach client closes its own connection.

Installing an update does not restart a running invocation. Existing windows
retain their loaded execution code; new windows load the installed build.
Source development runs read source files and do not provide an immutable code
snapshot across source edits. See the [implementation plan](../specs/window-runtime.md)
for remaining release and installation validation.

## 安装和后台升级

官方安装器将验证后的每个构建保存在 `.versions/<build-id>/`，再原子切换启动入口。
构建标识与公开版本号独立，同版本重编译也不会覆盖已有文件。当前窗口固定自己的可执行文件；
后续 sandbox 子进程仍从同一构建启动，新窗口使用新入口。不自动清理保留的构建。
Windows 使用 NTFS hard link 与 `File.Replace`，避免覆盖正在执行的文件。安装失败保留原入口。

仅官方安装渠道自动后台安装；包管理器渠道提示更新，由用户手动执行。源码入口不提供源码编辑后的运行快照。
preview 先在构建机编译，再执行 `./script/install-local.sh --binary /path/to/prebuilt/miao`，
独立安装到 `miao-preview`，回退入口指向上一次保留的构建。
