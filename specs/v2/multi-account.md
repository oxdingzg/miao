# Multi-Account Provider Support

Status: shipped except for one gap; this document records the design and what
`main` implements today.

## Implementation status (main, as of this revision)

An account is a stored credential, and a provider can hold several. Shipped:

- Storage: `credential.active` plus `Credential.create` (same
  `(label, method)` updates that row and flags it active, a new pair inserts a
  second account) and `Credential.activate(id)`
  (`packages/core/src/credential.ts`).
- Resolution: `resolveConnections` projects `active` and orders the flagged
  account first, newest-first after it
  (`packages/core/src/integration.ts`), surfaced as
  `Connection.CredentialInfo.active` (`packages/schema/src/connection.ts`).
- API: `credential.list`, `POST /api/credential/:id/activate`,
  `PATCH` (label), `DELETE` (`packages/protocol/src/groups/credential.ts`,
  `packages/server/src/handlers/credential.ts`).
- Clients: `miao providers list` prints every account with active/inactive, and
  the web app's Settings → Providers manages accounts (use/remove).
- Terminal UI: `/accounts` (also the provider switch and model dialogs) lists a
  provider's accounts with the active one marked, switches on select, and adds,
  renames, or removes one. Adding asks for the label first and passes it through
  `connect/key` and `connect/oauth`, so a second login is stored as its own
  account (4dc697e57c).
- Config: `accounts.<providerID>` per Location and `accounts` per agent, valued
  by credential label or id, resolved in `SessionRunnerModel`; the agent's choice
  outranks the Location's and a stale entry falls back to the active account
  (9e3242e0e0).
- Ownership: `Credential.create` refuses only the identity it replaces, and never
  writes the active flag of a daemon-owned row, so an owner-brokered account no
  longer blocks adding or rotating a different one (605bfbb98b).

One gap remains:

1. No session-level account binding: `Session.Info` carries no `credentialID`,
   so a session follows the account its provider resolves (active, config, or
   agent), never one pinned to that conversation.

The sections below are the original design and still describe the intended
semantics; where they differ from the shipped shape, the shipped shape wins
(`active` is a required boolean rather than an optional flag, the active-move
operation is `activate(id)` rather than `setDefault(integrationID, id | null)`,
and accounts are matched by `(label, method)` rather than by label alone).

## Problem

A user often has more than one account per provider: a personal and a work ChatGPT
login, two Anthropic orgs, an OpenRouter key per budget. miao today enforces exactly
one credential per provider:

- `Credential.create` deletes every existing credential of the integration inside
  its transaction before inserting the new row (`packages/core/src/credential.ts`,
  `create`). Logging in again silently replaces the account.
- `Integration.connection.active` returns `resolveConnections(...)[0]`
  (`packages/core/src/integration.ts`), and `resolveConnections` reverses the
  stored list, so "newest wins" is the only selection rule.
- Session model resolution calls `connection.active` once per provider
  (`packages/core/src/session/runner/model.ts`, `resolve` and `resolveSmall`).
  `Session.Info.model` is a bare `Model.Ref`; there is nowhere to record which
  account a session uses (`packages/schema/src/session-info.ts`).
- The TUI provider switch dialog lists providers only
  (`packages/tui/src/component/dialog-provider-switch.tsx`); the connect dialog
  stores one credential (`dialog-provider.tsx`).

The storage layer is nearly ready: the `credential` table has `label`, `active`,
and `time_created` columns, `Credential.list` already returns an array, and the
native engine already accepts `--credential-id`
(`packages/miao/src/engine/client.ts`). The pieces missing are add-vs-replace
semantics, a selection chain, per-session binding, and UI.

## Terms

- **Account** = one stored credential of an integration, shown to the user by its
  `label`. "Multi-account" means multiple credentials per provider, selectable.
- **Default account** of a provider = the credential other lookups fall back to.
- Provider keeps its current identity (`providerID` / `integrationID`); accounts
  never change model identifiers.

## Operation matrix

Accounts (credentials) are the unit the design adds, updates, replaces, and
deletes. Providers themselves are not mutable through this design.

| Operation | How | Mechanism |
| --- | --- | --- |
| Add account | login / connect with a **new** label | `Credential.create` inserts a row; nothing is deleted |
| Update account (rotate secret/token) | login / connect with the **same** label | `Credential.create` deletes the same-label row, inserts the new value; OAuth refresh also updates values in place via `credentials.update` without any delete |
| Rename account | `PATCH /api/credential/:id` | label change only, value untouched |
| Set default account | `PUT /api/integration/:id/default` | moves the `active` flag |
| Replace default account | set default to another account, or login with a new label while unflagged | the default rule (flag ?? newest) picks it up; nothing is deleted |
| Delete account | `DELETE /api/credential/:id` | cascade: sessions pinned to it degrade to the provider default; a cleared default falls back to newest; deleting the **last** credential disconnects the provider |

Providers are catalog/config entities, not rows this design writes: built-in
providers come from the integration registry, custom ones from `providers.<id>`
config. "Add a provider" stays "define `providers.<id>` or log in to a catalog
provider"; "remove a provider" stays "delete its last credential or set
`disabled: true`". Replacing a provider wholesale is not a concept here —
accounts are the switchable unit beneath a stable provider identity.

## Goals

1. Store and use several credentials for the same provider at the same time.
2. Pick an account per session, with a per-provider default for everything that
   does not pin one.
3. Add accounts without breaking existing single-account installs, the shared-DB
   preview flow, or the native engine path.
4. Account selection is visible: picker, sidebar label, CLI list.

## Non-Goals (this iteration)

- Automatic rotation on rate limits (the TUI already detects
  `account_rate_limit`; a retry-hook fallback is a follow-up).
- Per-account cost aggregation across sessions (turn usage already records the
  model; account attribution rides on session binding later).
- Multiple simultaneous accounts for one provider inside a single turn (small
  model and main model resolve independently, so this can differ today; that is
  acceptable and unchanged).

## Design

### 1. Storage: add, never silently replace

Change `Credential.create` semantics (core `credential.ts`):

- Insert always. Delete only rows whose `label` equals the incoming label, so
  re-logging-in with the same label rotates that account and a different label
  adds one.
- Labels are unique per integration, and `create` enforces it: OAuth settle
  derives `account-2`, `account-3`, … on collision, and if multiple rows ever
  match an incoming label the rotation replaces the newest and renames the rest
  rather than deleting them — "same label = rotate" must never destroy two
  accounts at once.
- Narrow the `CredentialDaemon.socket` ownership die to the rows this call
  replaces (same label). Today it dies when *any* credential of the integration
  is daemon-owned, which under multi-account would block rotating account A
  because account B is daemon-brokered; a daemon-owned account is still not
  replaceable from the TS broker, but unrelated accounts are unaffected.
- No schema migration needed. The `active` column (already in
  `packages/core/src/credential/sql.ts`, unique index already dropped by
  migration `20260611192811_lush_chimera`) is repurposed as the **default flag**:
  exactly zero or one row per `integration_id` has `active = 1`.

Default resolution rule (single function, used everywhere):

```
default(integration) = active-flagged credential
                     ?? newest credential by (time_created, id)
                     ?? env connections (unchanged)
```

This preserves today's newest-wins behavior for existing installs; the flag only
adds an explicit override.

### 2. Account identity labels

- OAuth settle (`integration.ts`, `connection.oauth` completion) derives the
  label from provider metadata when available — ChatGPT accountID/email,
  Copilot enterprise URL (the same fields `legacyOAuth` already maps) — then the
  user-supplied label, then `account-2`, `account-3`, … for collisions.
- Key credentials take the user-supplied label, else a masked tail (`…last4`).
- `Credential.Info` gains no fields; `label` plus the existing OAuth
  `metadata.accountID` convention is the contract. Rename stays via the existing
  `PATCH /api/credential/:id` (label).

### 3. Resolution chain (core)

`Integration.connection.active(integrationID)` keeps its signature but honors the
default rule above. Add:

```ts
Integration.connection.resolveFor(integrationID, account?: string): Connection | undefined
```

where `account` matches a credential ID first, then a label. Session runner
(`session/runner/model.ts`) replaces both `connection.active` calls:

```
account = session.credentialID            // explicit session pin
       ?? config accounts[providerID]     // per-provider config default
       ?? connection.active(integration)  // provider default (flag ?? newest)
```

A pinned credential that no longer exists (or belongs to a different integration
than the selected model's provider) degrades to the provider default with a
one-line warning, never a hard failure — account switching must not strand a
session whose model still exists.

### 4. Session binding

Add one optional field to `Session.Info` and the session update payload:

```ts
credentialID: Credential.ID.pipe(optional)
```

- `Model.Ref` stays untouched (it appears in commands, agent config, events;
  threading an account through it would touch every call site for no gain).
- The TUI model/account switch patches `model` and `credentialID` together.
- Next provider turn uses the new account; history and cost stay in the session.
- Small-model resolution (`resolveSmall`) follows the same session pin, falling
  back to the provider default.

### 5. Config surface

New optional top-level config block (`packages/schema/src/config.ts`):

```jsonc
{
  "accounts": {
    "openai": "work@x.com",     // provider default by label (or credential id)
  },
}
```

Per-agent override reuses the same shape under `agents.<name>.accounts`. This
deliberately does not overload `providers.<id>` — that block defines provider
catalog entries (api/models), and mixing selection into it would make
`providers.openai` mean two different things.

### 6. Login and account management

CLI (`packages/miao/src/cli/cmd/providers.ts`):

- `miao providers login <provider>` gains `--account <label>`. When the provider
  already has accounts, prompt: add another (default) or replace one.
- `miao providers list` (extends the existing list command) shows accounts per
  provider with the default marked and each credential's `time_created`.

TUI:

- Model picker (`dialog-model.tsx`): under the selected provider, an account row
  opens an account submenu (check = session pin, `default` tag on the provider
  default). Choosing an account patches the session; an "unset" entry clears the
  pin back to the provider default.
- Provider switch dialog (`dialog-provider-switch.tsx`) and connect dialog
  (`dialog-provider.tsx`): when the provider already has credentials, the connect
  flow offers "Add account" instead of implying replacement.
- Sidebar status shows `provider/model · <account-label>`.

### 7. Protocol / API

- `integration.list` / `integration.get` already project connections with
  labels; no shape change.
- New endpoint in the integration group: `PUT /api/integration/:integrationID/default`
  `{ credentialID }` (and clearing with `{ credentialID: null }`), publishing the
  existing `ConnectionUpdated` event so open UIs refresh.
- Session update payload accepts `credentialID` alongside `model`.
- Regenerate the client after the Protocol change (`bun run generate` from
  `packages/client`; never edit `src/generated` by hand).

### 8. Per-account model discovery

Providers whose catalog is discovered from the account (Command Code discovers
models from the connected account,
`packages/core/src/plugin/provider/commandcode.ts`) must key discovery by
credential, not by provider. The catalog plugin registers one integration per
provider; change the discovery call sites to accept the resolved connection and
cache per `(providerID, credentialID)`. Models of non-selected accounts stay
hidden from the picker until that account is selected — a wrong-model list is
worse than a short one.

### 9. Shared DB / preview channels

`mergeShared` (`packages/core/src/credential.ts`) currently deduplicates shared
credentials per integration. Change to per-credential merge: owned credentials
win for their own rows, inherited credentials from the stable DB appear as
additional read-only accounts (they already raise `SharedReadOnlyError` on
mutation). Default resolution prefers an owned row; if only inherited rows
exist, the newest inherited one is the default and mutation attempts keep
pointing users at the stable runtime.

### 10. Native engine

The engine already plumbs a specific credential (`--credential-id` /
`MIAO_ENGINE_CREDENTIAL_ID`, `packages/miao/src/engine/client.ts`). The session
runner passes the ID it resolved in step 3, so the native and TypeScript
engines cannot disagree about which account served a turn.

### 11. Security

- Keys and tokens never appear in labels, events, or logs; masked tails only.
- Removing an account that is a session pin degrades that session to the
  provider default (step 3 rule). Removing the last account disconnects the
  provider, same as today.
- Removing the default account clears the `active` flag rather than
  auto-promoting silently; the newest row wins by the fallback rule.

## Migration and compatibility

- No DB migration: `active` exists, multi-row `credential` is already legal.
- Existing single credentials keep working unchanged (label `default`/`legacy`,
  newest-wins fallback). The `auth.json` legacy bridge keeps importing at most
  one credential per integration and marks it `legacy`; it never blocks adding
  accounts on top.
- Channels: `miao-dev`/`miao-preview` keep sharing credentials through the
  shared-DB path with the new per-credential merge.

## Testing

- Unit (core): create add-vs-replace-by-label; default flag set/clear; fallback
  newest-wins; `resolveFor` by ID and label; wrong-integration pin degrades;
  shared merge per credential.
- Integration (core): two fake-OAuth credentials on one integration; session
  pinned to the second; runner resolves the second token and refreshes it
  independently.
- miao package: `providers login --account` flows; engine `--credential-id`
  passes the session-pinned credential.
- TUI: account submenu render and patch of `model` + `credentialID`; smoke via
  `bun dev` in tmux.
- Protocol: regenerate client in the same PR as the endpoint addition.

## Open Questions

- Should `agents.<name>.accounts` override or union with the top-level `accounts`
  map? Proposed: override per provider key, union across providers.
- Auto-rotation on `account_rate_limit` (opt-in per provider) is the natural
  follow-up; the provider-retry hook is where it lands.
