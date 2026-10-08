# App Timeline: V2-native transcript (staged cutover)

## Goal

Retire the app's V1-shaped message/part projection (`utils/session-message.ts` —
`normalizeSessionMessages` — plus the synthetic `message.updated` / `message.part.*`
events in `server-session.ts`) by making the app timeline consume V2
`SessionMessage` records natively, the way the TUI already does
(`specs/v2/v1-retirement.md`, roadmap §1.2 item 2).

This is an epic, not a cleanup: `normalizeSessionMessages` carries the rendering
contract — agent/model context inheritance from meta messages, shell commands
projected as a user+assistant turn pair, compaction parts, parent backfill — and
`@miao/session-ui/message-part` renders V1 `Part` shapes. It is staged so every
step ships green and the daily `miao` command never regresses.

## Current architecture (measured)

- `server-session.ts` reduces V2 durable events into `session_message`
  (`SessionMessageInfo[]`, the V2 skeleton) via `v2.reduce`, then projects them:
  `normalizeSessionMessages` → V1 `Message[]` + `Part[]` → synthetic
  `message.updated` / `message.part.*` events → the app reducer mutates
  `data.message` / `data.part`.
- The timeline model (`pages/session/timeline/model.ts`) reads `data.message[id]`
  (V1 `Message[]`) and walks the V2 skeleton
  (`constructSessionMessageRows(messages: SessionMessageInfo[], getMessage,
  getMessageParts, …)`) to build rows; part content is rendered by
  `@miao/session-ui/message-part` (2806 lines over V1 `Part` shapes).
- A V2 read of an un-migrated session is empty unless backfilled
  (`miao db backfill`), so the timeline must keep handling backfilled legacy
  rows through the same V2 records — which the backfill already projects.

## Why staged

The V1 projection is load-bearing for rendering. Flipping the store shape and
the renderers in one step would leave the app broken between commits and make
visual regressions unattributable. Each stage below keeps the app green and
ships independently; the V1 projection shrinks stage by stage until it is dead
code.

## Stages

**Stage 1 — V2-native turn construction.** `constructSessionMessageRows` stops
calling `getMessage` for turn structure: user/assistant turns, agent/model
context inheritance (from `agent-switched` / `model-switched` meta messages),
shell command pairs (`shell` → user turn + assistant output), synthetic-user
promotion, and compaction markers are derived from `SessionMessageInfo` alone.
Row payloads reference the V2 records (`SessionMessageUser`,
`SessionMessageAssistant`); the projected V1 `Message` store remains populated
(one stage behind) but the timeline no longer reads it for structure.
Acceptance: the transcript renders identically for plain, shell-heavy,
agent/model-switching, synthetic-notice, and compaction sessions; the store's
V1 `message` entries become write-only from the timeline's perspective.

**Stage 2 — V2 content in the timeline.** `getMessageParts` lookups are
replaced by the assistant's inline `content` and the user's `text` / `files`:
the timeline feeds session-ui V2 content. This stage adds V2 content
components to `@miao/session-ui/message-part` (or an app-level adapter that
projects V2 content into the V1 `Part` shapes, contained inside the timeline
model, clearly marked as the last bridge). Acceptance: the app renders
streaming deltas, tool runs (pending → running → completed → error), reasoning
and file parts from the V2 records alone.

**Stage 3 — projection retirement.** `normalizeSessionMessages`, the synthetic
events, `data.part`, and the V1 `Message` store are deleted; `data.message`
holds `SessionMessage[]` and `SessionMessageInfo` merges into it. The
`session-cache` / `session-trim` types drop `Message` / `Part`. Consumers
outside the timeline (`dialog-fork.tsx`, `prompt-input.tsx`,
`session-context-tab.tsx`, `session-header.tsx`,
`home-sessions-controller.tsx`, `sidebar-items.tsx`, `session.tsx`) switch to
V2 reads (`promptInfoFromUserMessage`-style helpers already exist for the
resend/fork flows). Acceptance: `grep -r "data.part\[" packages/app/src` is
empty and the typecheck proves it.

Execution inventory (verified on main after #401/#403/#404/#408):

- Migrated to record reads: `messageAgentColor` callers (session header,
  sidebar tint), `prompt-input` has-user check, `dialog-fork`, and the
  home-screen markdown preloader (#408).
- Remaining consumers need a V2-native context helper before the V1
  stores can die: `session-context-tab`, `session-context-usage`
  (context computation over V1 `Message[]`), the session retry flow
  (`session.tsx` `extractPromptFromParts`), and
  `use-session-commands`.
  Verified dependency surface (main, post #408): `getSessionContext`
  reads only tokens/providerID/modelID and its consumers use
  usage/total/counts plus `ctx.message.id` and `ctx.message.tokens.*`,
  all present on the V2 assistant record — a records variant of the
  metrics helper plus a `role`-to-`type` swap covers both context
  consumers. `estimateSessionContextBreakdown` reads `msg.id`, `role`,
  and projected parts, so it takes the same records-plus-
  `contentParts` treatment. `RawMessage` in session-context-tab renders
  the per-message V1 shape and needs a records-driven variant. The
  session retry flow and `use-session-commands` are mechanical:
  `extractPromptFromParts` over the `contentParts` projection.

Store-surgery prerequisite discovered while starting it: the shared
render `Data` contract lives in `@miao/session-ui` (`context/data.tsx`,
V1 `message`/`part`/`part_text_accum_delta` shapes, consumed by
`session-turn` and `message-part` — the latter reads the V1 delta
accumulate store for streaming bash text). The content projection
(`contentParts`, currently `packages/app/.../timeline/content.ts`, deps
are clean: schema types + effect + solid) must move into
`@miao/session-ui` first; session-ui's Data contract then becomes
`SessionMessageInfo[]` + the projection, and the app store surgery
(merge `session_message` into `data.message`, delete `part` +
`part_text_accum_delta`, retire `normalizeSessionMessages` and the V1
event branches) lands without touching package boundaries. The
legacy-bridge e2e scenarios (#401/#403) retire with the V1 event
branches; the settled-tool expansion contracts move to V2-native
sequences (expand while running, assert across completion).

Surgery map (measured on main, packages/app/src/context/server-session.ts):
the five V1 cases span `session.status`, `message.updated`,
`message.removed`, `message.part.updated`, `message.part.removed`,
`message.part.delta` in the event `apply` switch. They are entangled
with shared load bookkeeping — `messageLoads` (touched/removed/cleared
sets), `orphanParts`, `pendingParts`, `optimistic`, `deltaBases`,
`part_text_accum_delta`, `removedMessages` — some of which the V2
paths also use, so the cut deletes the cases plus the V1-only helpers
(`legacy-part-record.ts`, `indexLegacyMessage`, `cleanMessage`,
`normalizeSessionMessages`, `compareMessages`/`messageKey`) and the
`part`/`part_text_accum_delta` store writes in one pass, keeping the
load state the V2 reducer still consumes. The e2e fixture keeps its
V2 send helpers and loses `legacyPartUpdated` and the removal events;
the tool-state settled-re-delivery cases re-sequence to V2-native
(expand while running, assert across completion), the removal
scenarios drop, and collapse-state's diff-count update half drops with
its sibling-streaming half retained.

Execution state (branch `refactor/stage3-final-cut`, WIP commit
4d588fd91, do-not-merge): the V1 event branches, `normalizeSessionMessages`,
`part`/`part_text_accum_delta` stores, and the legacy mirrors are
deleted; `data.message` holds records end to end (fetch, apply,
records-native optimistic send). Remaining, in order:

1. Product-decision sites (compiler-enumerated, session.tsx
   :574/:654/:829/:1973/:2112, message-timeline :336/:957/:1069): the
   resend and revert flows read agent/model/summary from the V1 user
   message; V2 user records carry none. Decide: resend uses the current
   draft's agent/model (recommended) or a record-carried attribution
   lands first.
2. The optimistic-remove settle and the unit tests
   (server-session.test.ts optimistic/normalize cases).
3. The e2e fixture/spec redesign per the map above.

The regression suites to keep green: default e2e, timeline-stability,
and the session-ui content tests.

Execution state after the second pass (branch
`refactor/stage3-final-cut`, two WIP commits, do-not-merge): the V1
event branches, `part`/`part_text_accum_delta` stores, and
`normalizeSessionMessages` are deleted; `data.message` holds records
through fetch/apply and the records-native optimistic send; session-ui
nav + Data contract + message-part last store read are flipped; the
global-sync reducer/cache/bootstrap tests are aligned. Remaining,
ordered: rewrite `timeline/projection.ts` over records (its
`assistantMessagesByParent` grouping uses V1 `parentID`/`role` —
records have neither; group by record order between user records),
then the session.tsx resend/revert sites with the decided
current-draft attribution, then message-nav/model tests, then the e2e
fixture/spec redesign. The compiler enumerates everything else.

Second entanglement, one layer up: `fetchMessages`/`applyMessagePage`
shape a `MessagePage` as `{session, part, source, sourceMode,
projectSource}` and the optimistic prompt flow books V1 parts through
`optimistic`/`confirmOptimistic`/`mergeOptimisticPage`/`replaceParts`.
The store cut therefore rewrites the page contract to
`{source, sourceMode, cursor, complete}` (records only), replaces the
optimistic parts booking with a records-native pending-user insert,
and deletes `replaceMessages`/`replaceParts`/`reconcileFetched`
(parts)/`deleteMessageParts`/`mergeOptimisticPage`/`SKIP_PARTS` with
it. Sequence the optimistic-flow rewrite FIRST inside the same change:
the send path is the one behavior the e2e suites cannot mock around.
- Store-surgery order once those land: delete `data.part` writes and
  readers → merge `session_message` into `data.message`
  (`SessionMessageInfo[]`) → delete `normalizeSessionMessages` and the
  V1 event branches in `apply()` → drop `Message`/`Part` from
  `session-cache`/`session-trim` → remove the event-reducer V1 branches.
- Deleting the V1 event branches also retires the legacy-bridge e2e
  scenarios introduced by #401/#403 (settled-tool re-delivery, part
  removals, the collapse-state diff update); redesign or drop them in
  the same change.
- Acceptance stays as specified above, plus the timeline-stability and
  regression suites green locally.

**Stage 4 — plugin/SDK surface.** The remaining V1 `Message` / `Part`
view-model aliases serve only the plugin hook surface and the export format;
they are retired with the plugin API versioning tracked in
`specs/v2/v1-retirement.md` (phase 4). Out of scope here.

## Acceptance for the epic

- `grep -rn "normalizeSessionMessages\|data.part\[" packages/app/src` is empty.
- The app suites pass and the e2e `session-request-docks` / `session-timeline`
  specs pass on every stage.
- Visual parity: transcript screenshots for streaming, tool-heavy, shell,
  compaction, and backfilled-legacy sessions match the pre-cutover renders.

## Non-goals

- Changing the V2 wire or the server reduction.
- Touching the TUI (already V2-native).
- Retiring the plugin hook V1 surface (phase 4 of the retirement plan).
