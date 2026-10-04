# Persistent local Runtime

The default TUI, `miao run`, and `miao --mini` connect to a persistent local
Runtime. The first client starts it in the background. Closing the interface
does not terminate other clients or running sessions. Ctrl-C in a headless run
interrupts the observed execution, using its identity so a delayed request
cannot interrupt a successor.

The Runtime hosts the session API and IM connectors together. `/remote` uses
the current connection and credential; `miao remote login wechat` and
`miao remote login qq` also use that Runtime. A completed login joins its IM
router immediately.

```sh
miao runtime status
miao runtime stop
miao runtime start  # foreground; useful for service supervisors
```

`miao remote` is also a foreground Runtime entrypoint. Existing launchd plans
therefore keep their foreground process instead of spawning competing owners.
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

Startup configuration remains owned by the Runtime. Changing the miao version
or `MIAO_CONFIG_CONTENT` requires stopping that Runtime first; a new client
cannot silently replace another session's configuration. A graceful stop
interrupts active execution, closes IM channels and service scopes, removes
discovery information, then releases storage ownership. Restarting preserves
session history but does not automatically repeat interrupted provider or tool
work.
