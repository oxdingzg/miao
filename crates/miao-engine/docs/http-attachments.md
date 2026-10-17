# Shared HTTP attachments and engine lifetime

The `engine-http-0` transport can serve several window-local clients from one
native runtime. The runtime remains the single writer of its engine database;
closing a client connection does not shut down that runtime.

By default `serve --http ADDR` retains its existing indefinite server lifetime.
The optional `--http-idle-ms MS` enables attachment leases and automatic idle
shutdown. The CLI accepts 1000 through 3600000 milliseconds.

## Attachment leases

`POST /lease` uses the same bearer token as `/rpc` and `/events`:

```json
{"client_id":"window-unique-id","release":false}
```

A successful request returns `{"accepted":true}` and renews that client's
lease. IDs are nonempty ASCII alphanumeric strings with `-` or `_`, up to 128
bytes. The server accepts at most 128 distinct attachments. Authentication and
validation failures do not extend the engine lifetime.

Clients must renew more often than the configured idle interval. For example,
with a 30000 ms interval, a 5000 ms heartbeat leaves room for transient client
scheduling delays. A closing client sends the same request with `release:true`;
it must not issue a global shutdown request or kill the engine process.

## Idle shutdown

Expired leases are removed by the server. Once no attachment remains, the
engine waits one further idle interval before shutting down. Running turns,
background jobs, armed timers and CRON tasks retain the engine even without an
attached window. Lease admission and the final shutdown decision are serialized
so a client cannot receive an accepted lease after shutdown has begun.

When idle shutdown begins, existing SSE streams close as well; an abandoned
stream cannot indefinitely block graceful shutdown. A client attaching during
shutdown receives `engine_closing` and must reconnect through its engine owner.

This profile adds lifetime management only. It does not authorize automatic
replay of provider work, relocate a Session, migrate product storage, or weaken
the engine database's single-writer lease.
