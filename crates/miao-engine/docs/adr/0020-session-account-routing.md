# 0020. Independent Session account intent over registered model families

Status: accepted

## Context

The host owns credential discovery and refresh. Native model routes already bind
trusted credentials, endpoints and variants, but their public catalog deliberately
omits credential identities. A product `switchAccount` cannot resolve a credential
by treating it as a model id or by exposing credential data to the controller.

Account selection must also remain orthogonal to model selection. Writing an
account change as a new explicit model binding would accidentally pin an agent's
default model, preventing a later agent switch from choosing its own default.
Conversely, changing a model variant must not silently discard the account pin.

## Decision

A trusted route manifest may carry bounded `account` metadata:

```
{ id: credentialID | null, model_key: logicalModelKey, default: boolean }
```

`model_key` names the host's logical model family. It is not inferred from route
id syntax or the provider's wire model: two unrelated host models can use the
same wire model name. `id:null` supports default environment or non-bearer chains
without pretending they are stored credentials. Metadata is internal to route
resolution and is not serialized by `model_catalog`.

`select_account {session_id, credential_id: string | null}` resolves only routes
already registered by the host. A non-null id selects that credential within the
current model family. Null selects the declared default account of that family.
The explicit variant is retained; a target missing it is refused. Ambiguous or
unknown accounts fail before durable mutation. Existing route/model-bound opaque
history continues to require compaction on its original route before switching.

Account intent is recorded independently as `session.account.selected`:

- `account:{credential_id}` is the Session's pin (null means configured default).
- `account:null` means no override, used when an explicit model-route selection
  itself specifies a non-credential route.
- The event may include the binding resolved at admission as a receipt. That
  binding is not promoted into an explicit user model selection.

At each provider-turn boundary the engine combines explicit model selection,
agent model default and process default with the independent account intent.
A running turn retains its already selected provider. Subsequent turns resolve
again and revalidate opaque-history ownership. Forks inherit the two state axes
at their chosen history watermark.

An ordinary model/variant change retains the independent account pin. Explicitly
selecting an account-specific model alias updates model and account intent in one
store transaction; this preserves existing exact-route selection semantics.

## Host bridge

The product registers its active connection as each model family's default route
and usable alternative stored credentials as additional opaque route ids. The
broker remains the only credential refresh writer. Enumerating alternatives and
selecting one never activates it globally. Manifests contain references only.

The product account endpoint forwards opaque intent, Session info projects the
pin, and account events replay with stable product event identities. There is no
new credential-writing API or separate execution loop.

## Rejected alternatives

- Encoding account changes as ordinary explicit model selections: it couples two
  independent axes and defeats agent defaults.
- Matching only wire model/protocol: distinct logical models can share them.
- Resolving credentials or constructing new endpoints from controller arguments:
  it bypasses the trusted host route registry.
- Silently resetting an unavailable variant or choosing an arbitrary matching
  account: both discard explicit user intent.
