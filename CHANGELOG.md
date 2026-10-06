# Changelog

All notable changes to **miao** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and miao adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tagged `vX.Y.Z`. GitHub release notes are generated from Conventional
Commits by `script/changelog.ts`; run `bun script/changelog.ts --version X.Y.Z --write`
to add a section here.

## [Unreleased]

## [0.1.15] - 2026-10-06

### Changed

- **runtime**: each CLI/TUI window owns its execution and local API; exit, terminal close, and ACP EOF close its resources (#260, #261, #268).
- **remote-control**: explicitly enable remote access for the current window; independent windows keep separate identities, permissions, and lifetimes (#265).

### Fixed

- **llm**: treat provider streams that end without a terminal frame as retryable failures (#269).
- **core**: allow concurrent windows to share history while keeping exclusive Session execution ownership and safe database maintenance (#256, #259).
- **installation**: atomically switch launchers to immutable builds so active windows and their later child processes retain their version (#266).

### Removed

- **runtime**: detached daemon reuse, service management, idle retention, and execution workers (#268).

## [0.1.14] - 2026-10-06

### Added
- **runtime**: exit the Runtime once nothing is active (#243) (`10ef87f67`)

### Fixed
- **tui**: restore the terminal when a fatal error exits (#252) (`2140022d0`)
- **tui**: load the session route without an empty text placeholder (#251) (`5adf9aa3b`)
- **tui**: keep the data context alive when a location bucket is missing (#250) (`1ddd2d36f`)
- **core**: skip rebuilding reference-free structured tool output (#249) (`45cbbe066`)
- **core**: avoid duplicate credential reads in integration lookups (#246) (`7ea8a0e06`)

## [0.1.13] - 2026-10-06

### Added
- **core**: bound machine wakeups per human prompt (#242) (`f9eef5fa5`)
- **script**: add measured latency baseline reports (#239) (`8c41dc605`)
- **core**: let a running subagent report to its parent (#237) (`973305735`)
- **runtime**: add the activity vector and idle-linger configuration (#232) (`861ae7533`)
- **core**: drive a running process through a terminal (#234) (`9b7669592`)
- **core**: read another session's transcript (#233) (`a6d4ec3a6`)
- **core**: serialize tool calls by declared concurrency (#230) (`6200473a3`)
- **core**: add a per-session lease and participant database access (#229) (`58613e008`)
- **core**: add the workflow tool (#223) (`55009203e`)
- **core**: add the push_notification tool (#225) (`56fce3a32`)
- **core**: add cron and schedule_wakeup tools (#224) (`0f71e8b70`)
- **core**: let the request decide whether a plan is the deliverable (#217) (`706453e08`)
- **core**: add the monitor tool (#221) (`bffc4b94b`)
- **core**: add enter_worktree and exit_worktree tools (#218) (`29bb627b3`)
- **tui**: estimate per-structure sync heap bytes (#214) (`589f3bdc0`)

### Changed
- **tui**: lazy-load the session route (#215) (`cec1b42d`)

### Fixed
- **core**: resolve selected session models without scanning the catalog (#244) (`9cb6ef2d`)
- **llm**: tolerate unknown stream frames and surface in-band provider errors (#241) (`9d5f819d`)
- **ci**: give every main commit its own workflow run (#238) (`2439800e`)
- **ci**: cache the real turbo directory and gate workflows by path (#235) (`335d52af`)
- **tui**: show relay setup in /remote-control (#228) (`30d7f2eb`)
- **miao**: record uncaught errors so a flash exit leaves a trace (#226) (`5729202b`)
- **core**: keep responses in the user's language (#219) (`cf3542f0`)
- **core**: guard plan-mode switches against a catch-all allow (#216) (`472aae72`)
- **release**: read the Chinese notes mirror from main when publishing (#213) (`5d81d5dc`)

## [0.1.11] - 2026-10-05

### Added

- **ios**: Support OAuth sign-in to OAuth-only Hubs and a preconfigured Hub origin (#194). This release includes the iOS source changes; the CLI archives do not distribute an iOS app.

### Fixed

- **ios**: Return to the workbench after a successful sign-in while keeping account management available.
- **runtime**: Allow clients from different software releases to share a verified Runtime with a supported wire protocol. Installing an update no longer prevents newly opened clients from joining the existing Runtime (#195).
- **runtime**: Allow cross-release status and graceful stop; show the running service release and protocol and wait for storage ownership to be released (#195).

### Upgrade behavior

Existing windows and active tasks continue running while the installed program is updated. Newly opened windows use the installed client build and connect to the compatible shared Runtime. The Runtime keeps its execution build until explicitly restarted; automatic installation does not restart active sessions.

## [0.1.8] - 2026-10-05

### Added
- **core**: add durable background subagent handoff (#144) (`64030825c`)

### Fixed
- **core**: accept state-less Command Code browser callback (#149) (`ba596d6f9`)

## [0.1.7] - 2026-10-05

### Added
- **tui**: list connectable providers in the switch-provider dialog (#138) (`2f68cb960`)
- **provider**: add Command Code subscription provider (#129) (`775824cc3`)
- **remote-control**: authorize durable agent and model selection (#134) (`2ad145fd5`)
- **core**: stream shell output to managed storage (#132) (`265e1a7a4`)
- **remote-control**: persist browser identities and prove pairing (#123) (`31cb23b94`)
- **core**: add the plan_enter switch and fix Windows test/PDF dependency handling (#120) (`f66ffacdc`)
- **core**: record background job lifecycle durably (#111) (`eef1fec6b`)
- **tui**: configure relay login within remote control (#122) (`1eea09b9e`)
- **runtime**: configure outbound remote control without restarting sessions (#121) (`ccc1f538b`)
- **core**: prepare durable slash commands at runner boundaries (#114) (`7343df88f`)
- **ios**: authorize relay connections through Hub accounts (#117) (`202e4fe4c`)
- **core**: keep the goal across compaction and report compaction count (#116) (`edae851bd`)
- **core**: add recall tool for durable session history (#115) (`a72c4aa48`)
- **ios**: authenticate Hub accounts and discover registered hosts (#109) (`c59910718`)
- **hub**: authorize browser upgrades with one-use Runtime tickets (#110) (`bf1495216`)
- **core**: expose background-job observation and control tools (#105) (`9b0eb33c7`)
- **core**: route V2 patch derive through the native addon (#103) (`96fe85808`)
- **core**: add plan_exit approval switch to the build agent (#102) (`f1921c9fc`)
- **core**: add a durable session goal tool (#104) (`d7fdff530`)
- **hub**: bind account directory and authenticated relay roles (#99) (`3fb3de7b2`)
- **core**: cap concurrent session drains (#100) (`16d0f501a`)
- **hub**: add durable account authentication foundation (#98) (`ac6a5038c`)
- **ios**: pair native devices through owner approval (#96) (`42e27ef47`)
- **tui**: pair and revoke remote-control devices (#95) (`57ad46c50`)
- **runtime**: manage pairing through authenticated local API (#94) (`a63c15b54`)
- **remote-control**: bind provisional pairing to local device approval (#93) (`1f2aa0c42`)
- **runtime**: connect encrypted Agent to scoped sessions (#92) (`362e64f7d`)
- **core**: persist remote operation admission receipts (#90) (`7d6bdddd6`)
- **ios**: connect native clients through encrypted Hub RPC (#88) (`232ff29f9`)
- **runtime**: host sessions independently of terminal clients (#83) (`d55210589`)

### Fixed
- **core**: recover dangling tool-call openers on stop turns (#139) (`670dc755f`)
- **miao**: validate tui arguments before the Windows VT check (#136) (`a06c0ad79`)
- **core**: recover background job observations after restart (#133) (`7965c8f02`)
- **core**: detect multi-phrase provider repetition (#127) (`d645641aa`)
- **core**: trigger compaction on reported usage before the window fills (#113) (`f4bfbde4f`)
- **core**: deliver peer messages at safe continuation boundaries (#112) (`3c63fccc8`)
- **core**: preserve text format and report final edit diffs (#108) (`16c1f465d`)
- **core**: invoke Windows PowerShell with -NoProfile -Command (#106) (`2620af4e6`)
- **core**: distinguish undispatched tools from unknown-outcome tools on recovery (#101) (`dd431edd7`)
- **core**: inherit parent model in subagent sessions (#79) (`07fdafb1c`)

## [0.1.6] - 2026-10-04

### Added
- **remote-control**: add authorized outbound Agent and durable grants (#87) (`1238d58a`)
- **ios**: persist remote operations and coordinate scene connections (#85) (`2a60a650c`)
- **core**: restore V2 LSP navigation tool (#74) (`4bd3dc762`)
- **core**: restore safe apply_patch file moves (#80) (`21ec0ccc1`)
- **ios**: add CryptoKit remote protocol core and interoperability checks (#72) (`d0e726605`)

### Fixed
- **app**: keep todo sync fresh across live updates and reconnect (#84) (`617f4ed63`)
- **core**: refresh persisted todos in session model context (#82) (`8352a2851`)

## [0.1.5] - 2026-10-04

### Added
- **core**: add `miao db retention` to report prunable events (#77) (`a314d26b7`)
- **remote-control**: add opaque authenticated relay hub (#70) (`6d16bd993`)
- **remote-control**: expose execution-aware interruption (#67) (`16ee7326e`)
- **core**: add OS-backed runtime storage ownership (#69) (`6b715ca7f`)
- **core**: add `miao db gc-blobs` to delete unreferenced blobs (#61) (`f4131241c`)
- **core**: add `miao db externalize-blobs` to move inline payloads into the blob store (#55) (`c6ec4b3ba`)
- **db**: report blob store and inline base64 in db stats (#56) (`dbd030930`)
- **core**: host project metadata writes and directory registration (#35) (`abf3c6b83`)

### Changed
- **core**: reconstruct a forked session from the projection (#75) (`390062cd3`)
- **miao**: retire the legacy project facade (#46) (`a760251de`)
- **app**: drop the identity server-compat shim (#40) (`479665d35`)
- **miao**: delegate the project service to core persistence (#36) (`ae1906f67`)

### Fixed
- **core**: refuse blob GC when other channel databases share the store (#68) (`ebfd2ff54`)
- **core**: mark blob GC across every channel database sharing the store (#66) (`2ad9efc71`)
- **core**: externalize session_message payloads by column type, not data.type (#65) (`85328ef5d`)
- **cli**: remove the duplicate Blob import in db commands (#62) (`e6995e0e6`)
- **core**: stop repetitive provider output without replaying tools (#53) (`bc23b5264`)
- **llm**: retry transient connection and timeout failures (#47) (`cf8f74f35`)
- **tui**: stop a stale full-sync todo snapshot from reverting a live update (#42) (`d7c5b059e`)
- **tui**: reconcile queued stream text with history snapshots (#45) (`0834754f9`)
- **tui**: drop older history when a session is deleted (#32) (`8ddd3b956`)
- **core**: release session caches when a session is deleted (#31) (`118ef0313`)

### Performance
- **core**: externalize oversized tool-result files to the blob store (#54) (`ab191634f`)
- **core**: page the durable log read instead of loading the whole tail (#52) (`061cef019`)
- **tui**: debounce the mention file search while typing (#51) (`ba786a496`)
- **core**: skip rewriting an assistant row when a durable event is a no-op (#50) (`d50308062`)
- **core**: skip the legacy read for a fully projected session (#49) (`a13c4b273`)
- **core**: cache base64 of immutable blobs across turns (#48) (`c70e58e99`)
- **core**: delete compact events by primary key instead of rescanning (#44) (`4f1704d0b`)
- **core**: reuse the session history cache when a revision bump changes no rows (#29) (`c286085b1`)

## [0.1.4] - 2026-10-04

### Fixed
- **miao**: forward streaming events only once (#24) (`fb880f18e`)
- **core**: decode Windows shell output by console code page (#23) (`53df1c90e`)
- **tui**: render prompt placeholder on a single row (#18) (`78c64e93a`)
- **core**: decode only changed rows when reloading session history (#17) (`0e0828566`)
- **core**: neutralize leaked tool-call text in projected history (#16) (`5312554e0`)
- **core**: detect tool-call leaks whose openers the server ate (#14) (`2d3c60d6c`)
- **core**: seed Tencent Token Plan models in the V2 catalog (#13) (`96da9b728`)
- **miao**: correct the health endpoint and stale e2e copy (#11) (`0e1829712`)

### Performance
- **tui**: apply durable session events incrementally (#21) (`4d2d1ad20`)
- **tui**: window the transcript around the viewport (#22) (`4e430437e`)
- **core**: drop legacy metadata from the history read path (#19) (`0177fc28f`)

## [0.1.2] - 2026-10-04

Published release: [v0.1.2](https://github.com/oxdingzg/miao/releases/tag/v0.1.2).

### Fixed

- **cli**: positional provider names work with `miao auth login opencode` and
  `miao auth login opencode-go`, instead of being treated as invalid URLs.
- **integration**: OAuth connection accepts omitted prompt inputs from older clients,
  and the TUI explicitly sends empty inputs for methods without prompts.
- **llm**: retry transient TLS verification failures within the existing retry budget;
  definitive certificate errors remain non-retryable.
- **tui**: show outgoing session message receipts and avoid history reloading for
  repeated busy status heartbeats.
- **miao**: monitoring probes and writes are asynchronous, with one sample in flight
  and windowed event-loop metrics.

- **miao**: Windows binary installations upgrade through native PowerShell 5.1,
  including system proxy support, release verification, and replacement of a running
  executable with rollback on failure. Errors identify the failing phase. Windows
  releases also include the x64 baseline archive for CPUs without AVX2.
- **app**: session archiving uses the V2 archive endpoint. Streaming preserves content
  order and existing text when new fragments arrive after loading history, and native
  idle events update the session status.

### Changed

- **sdk / plugin**: retire the legacy network SDK and migrate App, TUI, CLI, and
  plugin consumers to `@miao/client`. Use `OpenCode.make(...)` and capability groups
  such as `client.sessions`; endpoint values no longer have an extra transport
  envelope. `@miao/sdk` now owns the Effect-native scoped embedded host. See
  [the migration guide](docs/client-sdk-migration.md). Function-returning V1 `Hooks`
  remain deprecated; current plugins use `/v2/promise` or `/v2/effect`.

### Added

- **protocol**: `GET /api/fs/content` returns location-scoped UTF-8 text or base64 binary
  content. The TUI diff highlighter now uses this endpoint.

## [0.0.35] - 2026-10-03

Published release: [v0.0.35](https://github.com/oxdingzg/miao/releases/tag/v0.0.35).

### Removed

- **core**: the V1 session runtime (`packages/miao/src/session`), the legacy tools
  (`packages/miao/src/tool`), and the `/session/*`, `/permission/*`, `/question/*`, and `/sync/*`
  routes. Every shipped client now runs V2. The migration readers (`miao db backfill` / `compact` /
  `restore`) and old-shape config reading remain.
- **miao**: the `miao github` command; use `miao pr`.

### Changed

- **core**: the OS sandbox for `bash` is part of the V2 tool, opt-in through `sandbox` config or
  `MIAO_SANDBOX=1`.

### Added

- **protocol**: add /api/mcp/resources route (`3f604a5a2`)
- **protocol**: add /api/capabilities route (`c311394b5`)
- **protocol**: add /api/control-plane/move-session route (`330141bfc`)
- **protocol**: add /api/workspace routes (`0537c126a`)
- **protocol**: add /api/mcp status and connect routes (`0515122fa`)
- **core**: materialize blob references in session events (`182042946`)
- **protocol**: add /api/vcs get and status routes (`ca7ce8574`)
- **core**: materialize blob references in assistant tool results (`aa4628dc1`)
- **protocol**: add /api/config/catalog route (`83451a58e`)
- **protocol**: add /api/config/providers route (`ebb0a5337`)
- **core**: bound images at the prompt and tool-result boundaries (`eb3f723f1`)
- **core**: shrink images to a target budget before they reach the model (`db81445e8`)
- **protocol**: add /api/config get route (`3b0557817`)
- **core**: write the provider wire archive to disk (`e419f5479`)
- **llm**: record the provider wire behind an injectable archive (`ad9c9517e`)
- **core**: close two session black-box gaps (`493fa0b3d`)
- **protocol**: add /api/lsp status route (`6fbf8e1a5`)
- **protocol**: add /api/formatter status route (`6fe24d4a0`)
- **core**: add miao db restore --merge-from (`5083eb13c`)
- **tui**: jump to the start/end of the input with cmd+left/right (`07296f001`)
- **tui**: read clipboard images the mtty host forwards (mtty ADR 0036) (`3373a2158`)
- **miao**: run the interactive --mini mode on the V2 session API (`967c1c22a`)
- **acp**: add a V2-only ACP adapter on @miao/client (`42ef39cdd`)
- **protocol**: expose the location default model (`2b7f0302a`)
- **core**: read PDF pages as text or rendered page images (`f51f23187`)
- **miao**: log a legacy-route warning for every V1 session route hit (`a877248e3`)
- remove session sharing and export app sessions through V2 (`be0b265ac`)
- **miao**: remove the github command and start pr checkouts on V2 (`33e0885ce`)
- **miao**: back up and backfill legacy sessions automatically at startup (`7364b5333`)
- **miao**: export and import sessions through the V2 projection (`840c35ea5`)
- **core**: pass plugin shell.env variables to the V2 bash tool (`ffc473c87`)
- **core**: approve V2 bash per command with BashArity prefix rules (`7d1d2c640`)
- **core**: report LSP diagnostics after V2 apply_patch (`70e3b2f30`)
- **core**: serve per-turn session diffs for V2 DiffSummary (`58d6117d5`)
- **core**: publish V2 session status, retry and failure events (`11ccbabde`)
- **core**: generate V2 session titles after the first prompt (`939b07828`)
- **core**: read CLAUDE.md, CONTEXT.md and configured instructions in V2 context (`6481dbd95`)
- **core**: route Amazon Bedrock through the V2 session runner (`8b4944069`)
- **core**: route Google Vertex through the V2 session runner (`79a50c8aa`)
- **core**: route Azure OpenAI through the V2 session runner (`c984256fb`)
- **core**: route GitHub Copilot through the V2 session runner (`bf6f3fed2`)
- **core**: carry V1 codex, copilot and cerebras request overrides into V2 routes (`5ec5a87a8`)
- **core**: warn once when a deprecated V1 Hooks plugin is configured (`14a9b7424`)
- **core**: load custom and plugin-provided tools in V2 behind PermissionV2 (`e5ae5f740`)
- **core**: add V2 tool.execute.before/after and tool.definition plugin hooks (`22cb3be47`)
- **tui**: show bash stdin in the transcript and permission prompt (`bceef1ebe`)
- **core**: parse bash commands before running them and accept stdin (`25c8cc99d`)
- **miao**: start miao remote without accounts and back /remote with local logins (`a0250bf16`)
- **tui**: log in and start or stop the remote daemon from /remote (`6b22d5ed5`)
- **remote**: add a daemon control that plans and runs launchctl or a detached start (`55b17a7fd`)
- **tui**: add the /remote dialog for IM connectors (`7a316fbc0`)
- **server**: add the remote daemon control routes (`92c92260e`)
- **remote**: add the QQ bot connector (`02a32b575`)
- **remote**: add the connector framework and move WeChat onto it (`8781c005b`)
- add a PowerShell installer for Windows (`194a5198e`)
- **tui**: restyle the miao theme around neutral greys and a green accent (`22ef7128f`)
- **miao**: add miao remote command (`847f839af`)
- **core**: add remote config to V2 and V1 config schemas (`2951f2443`)
- **remote**: add WeChat iLink channel with QR login (`8de198148`)
- **remote**: add channel-agnostic IM router over the V2 client (`b026d14eb`)
- **core**: add a built-in office-documents skill that renders Office files with CJK font fallbacks (`301d330d7`)
- **core**: run V2 bash commands under the OS sandbox (`7f28f8711`)
- **core**: add sandbox config to V2 and V1 config schemas (`d99d439f4`)
- **tui**: give miao its own theme and keep opencode's as opencode (`663023e2e`)
- **tui**: preview code and diff colours in the theme picker (`1bb5d9504`)
- **llm**: reuse a session's Responses WebSocket across ChatGPT turns (`dd69dda34`)
- **cli**: run non-interactive miao run on the V2 session API (`335d6a798`)
- **tui**: show pickers above the prompt with numbered options (`917383349`)
- **tui**: render tools as inline rows and window the transcript (`93688562c`)
- **tui**: open model and provider selectors as a compact bottom sheet (`9ab315851`)
- **tui**: restyle the default theme around a neutral base (`47561bbdd`)
- report and display time to first token (`dda346a30`)
- **tui**: show turn throughput and cache hit direction in the sidebar (`e76e39770`)
- **tui**: age the prompt cache in the sidebar (`057bbceb7`)
- **tui**: roll up subagent spend and price DeepSeek off-peak (`19c3c909c`)
- **tui**: show what caching saved in the sidebar (`2aa863096`)
- **tui**: name the tool a live turn is running (`589d73a15`)
- **tui**: give read, edit, and write one indented result style (`081bbeeac`)
- **ui**: translate the tool result summary in every locale (`a635abd46`)
- **session-ui**: report a one-line tool result under finished calls (`27182db9f`)
- **tui**: let the terminal background show through the miao theme (`e647dcdbd`)
- **tui**: draw the block MIAO wordmark beside the home cat (`4c0502ba1`)
- **core**: retire legacy V1 session storage (`49b16011f`)
- **cli**: add miao db backfill --verify (`43b1d7848`)
- **cli**: add miao doctor and continuous process sampling (`617002c4b`)
- **tui**: show live elapsed time on running turn and subagent status (`f19353cdd`)
- **question**: align prompts with claude code preview and multiSelect (`6e5272fb3`)
- **core**: give V2 sessions the model family persona (`35feedb8b`)
- **core**: derive reasoning variants from declared model options (`b409f85b1`)
- **tui**: collapse reasoning and shell steps into an activity summary (`bf5f61dd1`)
- **core**: externalize oversized prompt attachments into blobs (`9f3c0b146`)
- **core**: generate model variants from inherited provider APIs (`a80b159f9`)
- **protocol**: add the V2 project group (current, directories) (`148abc278`)
- **core**: materialize blob attachments at request build (`8de602ac4`)
- **core**: wire tool progress checkpoints from context to the session (`2053cc91a`)
- **session**: create sessions with a current V2 event (`0db212ca5`)
- **core**: add blob reference helpers and base64 reads (`2badf0115`)
- **core**: settle pending permissions and questions on interrupt (`e70252662`)
- **core**: report outcome-unknown for crash-recovered tools (`05ce7c94d`)
- **core**: assert the message permission action for send_message (`0e27711e4`)
- **core**: add a list_sessions discovery tool (`0bf2ab9eb`)
- **core**: resolve send_message targets by @slug (`7cdafdc5b`)
- **core**: cap the session messaging inbound queue (`feb877ad2`)
- **core**: add session-to-session send_message tool (`d788db9a1`)
- **tui**: finish the V2 session-read cutover (`05489a4c8`)
- **tui**: list sessions and derive status from V2 under MIAO_TUI_V2 (`a9385d3cf`)
- **core**: cap oversized MCP image results (`22787fd74`)
- **core**: enable incremental auto-vacuum on new databases (`ed7449167`)
- **tui**: hydrate session diff from V2 under MIAO_TUI_V2 (`14c42464a`)
- **tui**: rename and remove sessions via V2 under MIAO_TUI_V2 (`b2384bbf0`)
- **tui**: read session info and todos from V2 under MIAO_TUI_V2 (`a66c3f7be`)
- **core**: add a content-addressed blob store (`04028881f`)
- **tui**: run the V2 runtime by default (`cd93b9076`)
- **app**: select V2 whenever the server advertises it (`89a23c160`)
- **core**: distinguish prompt-cache misses by cause (`06811d50e`)
- **app**: allow forcing the server protocol via ?protocol= (`ea167450d`)
- **core**: dedupe MCP tool names deterministically (`e37433ff7`)
- **tui**: render V2 permission/question requests and flip their replies (`b7ce517ad`)
- **core**: filter globally disabled tools at materialization (`3b952a348`)
- **core**: normalize image attachments by model capability (`6c797bffe`)
- **tui**: flip Stage 4 write paths to the V2 API under MIAO_TUI_V2 (`1dcefaddf`)
- **core**: poll the durable event tail for cross-process writes (`98664f60a`)
- **core**: report a failed subagent as a tool error (`f9942b06b`)
- **core**: bound ripgrep invocations with a timeout (`4b8e317b2`)
- **core**: recover from repeated context overflow with bounded re-compaction (`3ce997cc0`)
- **core**: serve a single un-migrated legacy message by id (`57d4c7ec3`)
- **core**: aggregate subagent step usage into ancestor sessions (`0f54fa79b`)
- **core**: retry compaction with the session model when the summary is refused or empty (`ccb8f7f3a`)
- **core**: keep tool definition order stable across provider turns (`38f4b5b19`)
- **tui**: read session transcript from the V2 API behind MIAO_TUI_V2 (`d1a2aa72f`)
- **core**: refuse to continue un-migrated legacy sessions on V2 (`3693fe4da`)
- **core**: add an opt-in V1 to V2 session message backfill (`c10b71bf8`)
- **core**: fall back to fuzzy matching in the V2 edit tool (`eb7c0c609`)
- **core**: read legacy V1 messages when no V2 projection exists (`092dbb54c`)
- **protocol**: add session.rename, session.archive, session.remove (`b5c0a71ce`)
- **protocol**: add session.command for slash commands (`b1da0ebd2`)
- **protocol**: add session.fork with identifier remapping (`cbbefff24`)
- **protocol**: add session.diff to the V2 API (`3bd8979d8`)
- **protocol**: add session.skill to the V2 API (`df2a4b9b2`)
- **protocol**: add session.shell to the V2 API (`00454eac0`)
- **protocol**: add session.status to the V2 API (`da37c4ef9`)
- **protocol**: make /api/health self-identify as V2 for client detection (`492b1f937`)
- **protocol**: add session.todo and session.children to the V2 API (`2a2338a8f`)
- **core**: add the V2 MCP runtime bridging server tools (`5c66e8c00`)
- **core**: add Tool.makeExternal for raw JSON-schema tools (`95f5c54d2`)
- **core**: add a goal/todo-driven autonomous loop to the V2 runner (`cf81bb20f`)
- **core**: add the V2 LSP runtime and feed diagnostics back to edit/write (`2a0e88792`)
- **core**: add an LSP JSON-RPC client (`e8324a415`)
- **core**: add LSP language map and diagnostic report foundations (`e41120fa3`)
- **core**: add the V2 formatter runtime and run it after edits (`a3c9c8d4f`)
- **core**: add session-scoped tools and the V2 task subagent (`e5b1df9a5`)
- **core**: let SessionV2.create record a parent session id (`ed682f461`)
- **core**: bound repeated identical tool calls in the V2 runner (`1637cb872`)
- **core**: implement session.compact for the V2 runner (`bab20e3f5`)
- **core**: implement session.wait for the V2 runner (`c36acf45f`)
- **cli**: add --format jsonl to session export (`3e5f0c360`)
- **cli**: add db stats and vacuum maintenance commands (`fc28cc9c9`)
- **plugin**: report agent state to the mtty terminal (`53c037dfa`)
- **provider**: list documented Tencent Token Plan models missing from models.dev (`674db112e`)
- **core**: enable the native edit/patch paths by default (`aa09adb84`)
- **shell**: run commands under the process sandbox when MIAO_SANDBOX is set (`2ac4cc590`)
- **native**: self-exec sandbox runner in the main binary (`c5cd3ebc5`)
- **native**: enforce TCP network denial in the Linux landlock sandbox (`6168cb124`)
- **native**: add shell command analysis for bash and powershell (`4eb2c7a6e`)
- **native**: add git diff rendering with git apply round-trip (`9bea07066`)
- **native**: add gitignore-aware file walking (`20d290dcc`)
- **native**: add sha256 and blake3 hashing (`d5078bba4`)
- **native**: add BPE token counting (`e08bfb0d2`)
- **native**: add line-ending detection and normalization (`472cf7051`)
- **native**: add git merge-base (`f11c79465`)
- **native**: add git worktree change listing (`2409f8b8e`)
- **native**: add git rev-parse and blob reads (`cb32d8e1d`)
- **core**: add an opt-in per-session cost budget (`e92ab243d`)
- **core**: opt-in tool-output pruning for provider requests (`1ceccf7b3`)
- **core**: complete prompt-cache telemetry and add cache.ttl_seconds (`e1246dffc`)
- **core**: budget the skill list in system context (`c4d5d5dda`)
- **core**: seed V2 credentials from legacy auth.json (`efc73356c`)
- **core**: add BPE token counting behind compaction.precise_tokens (`0d5480d02`)
- **core**: opt-in hot-prefix compaction (`9cb8f3389`)
- **core**: summarize compaction with the cheap model (`f9adcee3f`)
- per-provider native currency for cost display (`012ec10e8`)
- **tui**: add /currency cost display toggle (`efb71c45f`)
- **core**: add experimental Code Mode tool frontier (`309e25d3d`)
- **core**: add turn TTFT and cache-hit telemetry (`4b9770fb3`)
- **upgrade**: background auto-update with a restart notice (`d32b81052`)
- **native**: add landlock sandbox backend and opt-in gate (`7b9504684`)
- **native**: add async git status on the libuv threadpool (`23d682e52`)
- **native**: embed host addon in the build and discover miao-run (`3ce647d7e`)
- **native**: package the addon as @miao/native, embeddable in the binary (`1d094ccd0`)
- **native**: wire apply_patch behind MIAO_NATIVE with TS fallback (`988cbb921`)
- **native**: wire edit matching behind MIAO_NATIVE with TS fallback (`d4f33ec4d`)
- **native**: add sandbox denial escalation flow (`a86ed612e`)
- **native**: add --allow-path and --compat modes to miao-run (`ce4bf980f`)
- **native**: add gix git status and macOS seatbelt sandbox PoCs (`f8744b6ba`)
- **native**: port apply_patch chunk application to miao-native (`4aaf55cab`)
- **native**: add miao-native edit/diff pipeline PoC (`36b9d744d`)
- **tui**: animate the home cat logo with the shimmer effect (`b757e4fa1`)
- **core**: default to models.opencode.ai and ship a fallback catalog (`9dbd41bdd`)
- **tui**: open model and provider pickers from the prompt footer (`701358016`)
- rename CLI entry to miao and use a cat logo (`8c091ee4c`)
- **tui**: add double-click word selection (`da292cd63`)
- **opencode**: broaden native runtime gate to match adapter support (`c6b7884d9`)
- **core**: widen native model dispatch to more providers (`ff61b8984`)

### Changed

- **core**: remove the V1 session runtime (`40d38e69b`)
- **tui**: read commands, skills and current project through V2 (`9dd30fe8e`)
- **tui**: drop the dead background-subagents command (`7ba94241e`)
- **tui**: connect providers through V2 OAuth attempts (`cb2f91228`)
- **llm**: resolve the wire archive when the layer is built (`108a64efc`)
- **tui**: read provider auth through V2 integration (`aa5972a8d`)
- **tui**: read agents and project directories through V2 (`5c72d814c`)
- **miao**: drop unreachable V1 run branches (`a2608e8df`)
- **app**: remove the V1 protocol shim (`47ac58714`)
- **tui**: drop the V1 runtime flag and fallbacks (`ea77c4813`)
- **miao**: serve miao acp through the V2 adapter and drop the V1 ACP (`427c0b5f2`)
- **miao**: give plugins the regenerated V2 SDK client (`0b6ad93d2`)
- **tui**: send move and warp reminders through V2 and gate V1 event handlers (`318374c6c`)
- **miao**: back session list/delete and session validation with V2 (`b53cd7216`)
- **core**: move the sandbox runner and policy into core (`0b0435a79`)
- **core**: resolve integrations without a credential query per provider (`fe95bac05`)
- **app**: drop the V1 protocol option from createServerSession (`ddc72cf81`)
- **app**: remove V1 protocol branches from bootstrap, terminal, permission (`d7abcfdcd`)
- **app**: drop the V1 event stream and V1 session-list loading (`473b76508`)
- **core**: extract reusable session creation service (`09ec74c99`)
- rename the remaining TUI identifiers (`3373ad6f3`)
- rename opencode config files, service tags, data files, and domains to miao (`e6f6ddaa5`)
- rebrand the remaining user-facing copy and publish targets (`fcefd8ba8`)
- move configuration to .miao, keeping .opencode as a read fallback (`bb369d5f6`)
- strip the remaining opencode branding from user-visible surfaces (`fd61648e8`)
- rename the packages/opencode directory to packages/miao (`2510996bd`)
- rename the opencode package to miao (`0dab74d6c`)
- rename OPENCODE*\* env vars to MIAO*\* with a legacy mirror (`fbfbf9126`)
- rename workspace scope @opencode-ai to @miao (`36346a1fb`)

### Fixed

- **miao**: wait for plugin boot to commit reference paths before resolving agent directory permissions.

- **tui**: render deleted diff lines in a uniform foreground (`d1967a900`)
- **tui**: report waiting time from the last output, not the turn (`91b6afd07`)
- **core**: interrupt a subagent that stops producing events (`90d5c6544`)
- **session**: resume queued input after a single-press interrupt (`b70bf067f`)
- **protocol**: encode config passthroughs with the JSON codec (`cb8521ffa`)
- **server**: yield MoveSession at group construction (`95c0c638a`)
- **miao**: provide core Git to the route layer (`0861e8769`)
- **core**: refuse db compact when quick_check fails (`776fc4fc0`)
- **sdk**: catch the SSE reader cancel rejection when a stream is aborted (`46c3779b5`)
- **miao**: replay an interrupted V2 step without an error row, as live does (`dae92a5da`)
- **miao**: link a child created after bootstrap to its running task call (`5be607ca9`)
- **acp**: map edit previews back to the session directory the client opened (`8bd51173f`)
- **server**: wait for plugin boot before listing agents, commands and skills (`33018aa4c`)
- **core**: send attachments the route cannot carry as a note instead of failing the turn (`2877c92f8`)
- **core**: type the reused-backup migration result (`0cc7eabe5`)
- **core**: keep the first pre-migration backup instead of copying on every start (`9d9526a66`)
- **miao**: export V2-native compactions without a preceding reply (`685ce27a4`)
- **core**: type preserved legacy parts per part kind (`908a74609`)
- **core**: keep compaction, subtask, step and error detail when projecting V1 history (`ee94379f5`)
- **miao**: read stats from the V2 projection and count subagents once (`aa87cd304`)
- **core**: show the diff when V2 edit, write, and apply_patch ask for approval (`a7d25d3a5`)
- **core**: order configured instruction globs deterministically (`3cd5265a8`)
- **core**: keep the Azure resource name out of Foundry model auth (`2e3adb043`)
- **core**: bound the plugin-boot wait before materializing tools (`672840a5e`)
- **tui**: drive every spinner from one shared animation clock (`b60c0cbf2`)
- **tui**: split plugin paths with path.sep in the status dialog (`eb2c7e480`)
- **miao**: catch MCP browser launchers that exit before open returns (`06991b682`)
- **miao**: ad-hoc re-sign darwin binaries after local compile (`9e565fa83`)
- **core**: ask permission before running MCP tools (`4fcd0c883`)
- **miao**: refuse sharing with a 403 when it is disabled in config (`4672492f2`)
- **app**: restore the todo dock from the persisted V2 todo list (`6a27cb86a`)
- **app**: read structured tool metadata and restore branch info from /vcs (`83d20661f`)
- **tui**: stop the thinking spinner once its message has finished (`cabcb2683`)
- **remote**: hold results instead of pushing after a failed send (`9934f9656`)
- **tui**: stop the cache age clock once the cache is stale (`fa6717785`)
- **miao**: send V2 event data to clients in wire form (`a230e1302`)
- **core**: let the default persona post short progress updates (`6222e9d8a`)
- **llm**: retry a provider stream that drops before its first event (`6b04df361`)
- **tui**: show a one-line headline for thinking in hide mode when a step has no text (`17c53f2df`)
- **cli**: stop miao run's event stream as soon as the session is idle (`c6136eaca`)
- **cli**: print every turn's text in non-interactive miao run (`f71d42d42`)
- **core**: let provider plugins load without the plugin boot cycle (`8ee4076ae`)
- **client**: name the V2 project group projects in the client (`2ac22cb37`)
- **tui**: settle the terminal size after a coalesced resize (`c21daa1c4`)
- **tui**: never render a theme that lost its colors, and log theme changes (`1de1d668b`)
- **schema**: stop identifier time prefix from wrapping every 795 days (`4d84a7dce`)
- **core**: never let a catch-all allow rule lift the OS sandbox (`71036081c`)
- point config, TUI and theme schemas and the app icon at mtty.dev (`aa37b6da1`)
- **miao**: publish one config schema that accepts both runtimes' keys (`d6d9dedf9`)
- **core**: sweep only sibling requests when a permission is rejected (`880d704bb`)
- **core**: parse sandbox denials behind an absolute shell path (`01dac257d`)
- **miao**: export sessions from the V2 projection after db compact (`8c2291238`)
- **core**: drop a replayed tool call instead of failing the turn (`b264c816c`)
- **llm**: pause at least 250ms when a provider says Retry-After: 0 (`569bc579e`)
- **tui**: show tool commands, diffs and writes with syntax colour (`6fb7f2bb1`)
- **miao**: point ACP terminal sign-in and auth hints at miao (`f1ef34d7c`)
- **miao**: keep the retry action in retryable's return type (`14cd10036`)
- **app**: send support and feedback to miao's GitHub (`fe2f518ea`)
- **server**: stop trusting opencode.ai origins (`461a448db`)
- **tui**: stop advertising session sharing as on by default (`929ed243a`)
- **miao**: disable session sharing unless configured (`ebab6f676`)
- drop the OpenCode Go subscription upsell (`752423e83`)
- **provider**: attribute gateway requests to miao (`e7dc12667`)
- point docs and homepage links at mtty.dev (`61409e6e0`)
- **miao**: name miao in CLI errors, help and prompts (`b99c50236`)
- **miao**: uninstall miao's own package and PATH entry (`78f229fa2`)
- **miao**: run the current miao executable from miao pr (`c4354f95a`)
- point issue reports and docs at miao instead of opencode (`c1147b443`)
- **core**: inline text attachments instead of sending them as media (`0a84b8da4`)
- **core**: treat a provider's configured key as a connection (`2f9bfb84c`)
- **core**: honor the MIAO_CONFIG overrides in the V2 config (`81400160b`)
- **core**: request replayable reasoning from OpenAI reasoning models in V2 (`be78f9dcf`)
- **plugin**: report agent state to mtty through its MTTY\_\* variables (`f596c592a`)
- **core**: stop retrying a provider's 403 (`4177b492c`)
- **tui**: apply the selected model and agent before sending a V2 prompt (`7a58b74b8`)
- **provider**: stop offering OpenCode Zen free models (`b56f6023c`)
- **tui**: number every picker option and keep digits for search in long lists (`6206190a6`)
- **miao**: check for updates without the rate-limited GitHub API (`95870c0d2`)
- **core**: send the session-id header that ChatGPT uses for cache affinity (`b70bbcb44`)
- **tui**: highlight shell commands and their heredoc bodies (`cf3125225`)
- **tui**: highlight edit and patch diffs with the whole file as context (`fb5f94f18`)
- **release**: dispatch the release workflow on the fork (`4f0aae40d`)
- **release**: cut releases from the package.json version (`7390aa24b`)
- **tui**: send one permission reply per prompt and keep it on failure (`270de0183`)
- **core**: keep a dead language server from failing tool calls (`f921b6935`)
- **miao**: add the session children accessor to the tui plugin fixture (`6c3f3dba0`)
- **tui**: make the dialog backdrop opaque so it hides what is behind it (`ddcbd7c9a`)
- **tui**: read the pasteboard image without AppleScript's re-encode (`506c877ca`)
- **tui**: keep a pending cross-session message to two lines (`83e499cf8`)
- **tui**: drop a prompt receipt once the server projects it (`6ebf8363c`)
- **llm**: keep the transport failure cause in the error message (`659921aad`)
- **miao**: request the reasoning summary gpt-6 needs (`4a850064c`)
- **tui**: render the removal diff for deleted files (`2ba07b986`)
- **app**: read live session events from the current protocol (`5adff3598`)
- **session-ui**: highlight shell commands and collapse long output (`01ad7d183`)
- **llm**: keep reasoning options on later gpt-5 generations (`0dd6668e4`)
- **miao**: explain the retired legacy storage instead of failing on a missing table (`59cff6eb2`)
- **core**: keep patches and tool metadata in the V1 projection (`061ab11dc`)
- **core**: wait out a cold catalog for a session with no model (`668d0bef2`)
- **core**: serve catalog listings after the location plugin boot (`d4eb83296`)
- **core**: hide the models a Tencent Token Plan key cannot call (`fa623fa54`)
- **core**: detect cache misses on providers that never bill a write (`d42cb03e0`)
- **core**: prune tool output on the token budget the session already uses (`3bb90501a`)
- **core**: stop counting inline media as text in the compaction budget (`f18a6adea`)
- **tui**: page older history in when the reader reaches the top (`962129c0e`)
- **tui**: keep the reasoning header color reactive (`c0523f06d`)
- **tui**: keep thinking out of the transcript in hide mode (`17f8f7b81`)
- **tui**: aggregate turn activity on one status line (`190c47ab5`)
- **miao**: serialize background autoupdate and record its outcome (`c4ff10ba4`)
- **tui**: render V2 tool blocks and keep compacted history scrollable (`d6fdd1d7a`)
- **tui**: keep unpromoted prompt receipts at the transcript tail (`fc1899082`)
- **tui**: refresh when a V2 stream fragment has no projected part (`2f523cc31`)
- **tui**: echo V2 prompts before model promotion (`aa5d3fbb7`)
- **tui**: render inter-session messages with readable source and markdown (`f2325b6bf`)
- **tui**: show model response waits from execution status (`bd9fddc12`)
- **tui**: project V2 tool state into the V1 tool shape (`d50902487`)
- **tui**: refresh streaming sessions without debounce starvation (`3b80fb141`)
- **server**: provide project and saved permissions to request handlers (`3e73aaa6b`)
- **sdk-next**: pass request context to embedded http handler (`c942171a7`)
- **llm**: normalize empty assistant history for chat providers (`42360e390`)
- **tui**: prevent duplicate question settlement and reset queued prompts (`0ce96770e`)
- **tui**: dismiss question and permission prompts when the request is gone (`8c88d57d4`)
- **server**: load the embedded web UI from the miao asset module (`862a7327c`)
- **tui**: keep question enter and escape active and surface errors (`c76fcfb04`)
- **session**: resolve projected session locations to the request location (`d3efb47eb`)
- **core**: reload cached history when durable events publish (`23a6a8ae0`)
- **core**: persist model resolution failures as a failed assistant (`d62628dec`)
- **session**: answer unsettled tool calls when projecting history (`28c56731d`)
- **integration**: adopt legacy OAuth logins when listing integrations (`51a4ddb34`)
- **integration**: adopt legacy auth.json OAuth logins (`1b8f14569`)
- **session**: retry transient provider and catalog failures (`2246e89fb`)
- **oauth**: show miao branding and runtime version on callback pages (`9fae3777d`)
- **tui**: render live V2 runs under MIAO_TUI_V2 (`d0bb0a54c`)
- **core**: keep backfilled legacy history when forking a session (`47e230232`)
- **core**: make legacy backfill appendable and repair stranded history (`efa02089a`)
- **provider**: invalidate provider state when the models.dev catalog refreshes (`329570e32`)
- **core**: keep legacy V1 messages visible after a V2 projection is appended (`f6a35223e`)
- **core**: reject mid-line fuzzy matches in the edit tool (`e16294edc`)
- **tui**: open the full model list from the prompt footer (`c2d79130c`)
- **core**: fail a provider turn that ends without a completion frame (`9be726d25`)
- **core**: serialize migration application across processes (`1d2db2f69`)
- **tui**: render shell commands with the code syntax style (`74abf774b`)
- **tui**: remember the model last used per agent (`7ef850f5b`)
- **core**: build the location service graph once per directory (`9937d5416`)
- **tui**: switch providers from the model dialog instead of re-prompting (`f6953122c`)
- **auth**: preserve auth.json entries this build cannot decode (`19616f7f7`)
- **build**: typecheck against renamed @miao/script package (`efb5d4d8c`)
- **session**: drop assistant segments that serialize to empty content (`9aa5f1e15`)
- **core**: adopt models.dev catalog changes without restart (`08d30ac32`)
- **release**: label generated release notes with the version (`7dc9f819b`)
- **native**: parse Linux landlock denials and cover the runner in CI (`6ff552797`)
- **native**: import landlock Access trait for the linux build (`a71e29b2c`)
- **core**: keep cost savings lossless by default (`ebcd6d7fc`)
- **tui**: list configured providers before free models (`e8b2f6de8`)
- **core**: compute V2 session cost and usage totals (`aba83549d`)
- **tui**: match the exit banner to the installer cat + MIAO (`711cdd590`)
- **install**: redraw MIAO as solid block letters (`6db63702a`)
- **install**: use cat + MIAO text instead of split block letters (`d45e3592d`)
- **install**: align the MIAO block letters (`677084d0a`)
- **release**: upload only produced archives and drop macos-13 (`2aca62f2f`)
- **release**: make changelog generation best-effort (`ea2ede192`)
- **tui**: fall back to plain output when ANSI/VT is unavailable (`d0441910a`)
- **tui**: enable ANSI/VT on legacy Windows consoles (`3ee66109d`)
- **miao**: decouple updater and versioning from upstream opencode (`dad6132d9`)
- **tui**: brand terminal title and exit banner as miao (`83b6a0900`)
- **core**: keep startup working when models.dev is unreachable (`34c3fdf7a`)
- resolve lint errors in prompt input class and client test (`6beb0a4f3`)
- align auth fixtures and CORS origins with the rename (`c2b0f3ee1`)
- **ci**: use the renamed packages/miao path in Windows publish steps (`e99d1d41d`)
- **opencode**: make missing-provider error actionable (`088a912b9`)
- **tui**: show free models are ready instead of prompting to connect (`dcdaae4c4`)

### Performance

- **llm**: validate media without copying the payload (`070be2c37`)
- **tui**: repaint the home logo without rebuilding its text nodes (`67fceaba6`)
- **tui**: keep drizzle and the migrations out of the TUI thread (`ef1e66bfc`)
- **tui**: install runtime plugin support only for external plugins (`1752ff852`)
- **core**: import turndown only when webfetch converts HTML (`efeaff0c0`)
- **core**: load the BPE tokenizer on the first token count (`8fc018eff`)
- **tui**: list commands without their template bodies (`afccac24c`)
- **tui**: load the provider catalog only when a dialog needs it (`c689e91bb`)
- **tui**: rest the home logo shimmer when nobody is using it (`cefa68a09`)
- **tui**: spawn the server worker before loading the TUI config (`6630c1277`)
- **core**: load the location service graph only when a root needs it (`f1dab1080`)
- **tui**: reconcile session hydration in place (`d602e1691`)
- **tui**: apply V2 stream fragments without re-hydrating the transcript (`b593cfaa9`)
- **core**: cache session diff until the durable log advances (`44246821c`)
- **native**: keep deriveNewContents lines borrowed so it beats TS (`08cc30332`)
- **native**: preallocate unified diff buffer (`36a970cc4`)
- **native**: use memchr and direct slicing in miao-native (`aeecb4cb4`)
- **tui**: render before terminal theme detection (`9a5d915d6`)
- **tui**: paint the shell before TUI plugins finish loading (`b8c9ff120`)
- **core**: refresh models.dev catalog at most twice a day (`da73eb53d`)
- **vcs**: coalesce identical concurrent diff requests (`9756790ea`)
- **tui**: throttle streamed markdown re-parsing (`99013aaed`)
- **filesystem,tui**: fix quadratic directory index and release deleted session caches (`548772ff4`)
- **core**: cache decoded session history and memoize tool schemas (`dfcb68fde`)
- **core**: cut session projection reads and reuse sqlite statements (`0bea7bd73`)
- **cli**: load commands and global directories lazily (`cad933b87`)

## [0.0.15] - 2026-09-30

Published release: [v0.0.15](https://github.com/oxdingzg/miao/releases/tag/v0.0.15).

### Fixed

- **core**: generate OpenAI reasoning variants from inherited provider APIs, resolve standard variants during startup, route ChatGPT OAuth through Codex, and persist model resolution failures in the conversation.
- **core**: refresh cached assistant history when durable events update reply text or completion state.

- **tui**: switching away from a custom question answer restores Enter and Esc; failed replies and dismissals display an error.
- **server**: load the embedded web UI using the generated miao asset module name.
- **build**: root package.json is the single version source for builds, source runtime, and synchronized workspace manifests; inconsistent overrides fail before building.

### Added

- **core**: prompt-cache telemetry now reports `warm`, `expectedRebuild`, and `cacheMiss` per turn; `cache.ttl_seconds` can extend the prompt-cache TTL.
- **core**: opt-in per-session cost budget (`cost.budget_usd`) that warns and stops scheduling further turns once exceeded.
- **core**: opt-in tool-output pruning (`compaction.prune`) that clears older tool results from provider requests only.

### Changed

- **core**: compaction summaries use the session model by default again; the cheap model is opt-in via `compaction.summarize_small`.
- **core**: the native edit/patch paths are on by default; set `MIAO_NATIVE=0` to fall back to the TypeScript implementations.

### Internal

- **native (PoC; edit/patch wired on by default, the rest not wired)**: added `gitRevParse` / `gitBlob` / `gitWorktreeChanges` / `gitMergeBase` / `gitDiff`, line-ending detection and normalization, BPE token counting (o200k/cl100k), `.gitignore`-aware file walking, sha256/blake3 hashing, shell command analysis (bash/powershell via native tree-sitter), and Linux landlock sandbox enforcement (write allowlist + TCP denied by default). Each ships with Rust unit tests and JS parity tests (`gitDiff` is verified by a `git apply` round-trip).

## [0.0.12] - 2026-09-29

Published release: [v0.0.12](https://github.com/oxdingzg/miao/releases/tag/v0.0.12). Release notes for 0.0.5–0.0.12 are available on GitHub.

## [0.0.4] - 2026-09-27

### Added

- **core**: per-turn TTFT and prompt-cache hit-rate telemetry; the TUI sidebar now shows `NN% cached`.
- **core**: experimental Code Mode behind `MIAO_EXPERIMENTAL_CODE_MODE` — the tool set collapses behind one `execute` tool with a budgeted catalog.
- **core**: opt-in hot-prefix compaction (`compaction.hot_prefix`) that reuses the warm prompt-cache prefix for summaries.
- **core**: opt-in BPE token counting (`compaction.precise_tokens`) for accurate compaction thresholds.
- **tui**: `/currency` cost display toggle; the choice is persisted and defaults to USD.
- **currency**: providers can declare native prices and a `currency` so displayed cost matches the provider's real bill.

### Changed

- **core**: compaction summaries run on the catalog's cheap model when they fit, falling back to the session model.
- **tui**: the model picker lists configured/paid providers before free models.

### Fixed

- **core**: V2 sessions now compute real cost and usage totals instead of `cost: 0`.
- **core**: V2 credentials are seeded from the legacy `auth.json`, so already-connected providers are no longer re-prompted.
- **install**: local builds install as `miao-preview` without shadowing the release-managed `miao`.

## [0.0.3] - 2026-09-27

### Changed

- **install**: warm gradient banner with a `NO_COLOR`/non-TTY fallback.

### Fixed

- **tui**: exit banner matches the installer cat + MIAO wordmark.
- **install**: MIAO wordmark is drawn as solid block letters.

## [0.0.2] - 2026-09-27

### Added

- **upgrade**: background auto-update with a non-blocking "restart to apply" notice.

### Changed

- **release**: add `darwin-x64` and Windows `.exe` install support, plus the VT verification checklist.

## [0.0.1] - 2026-09-27

### Added

- Initial miao release, forked from opencode: independent versioning and update source (`oxdingzg/miao`), rebrand, and the `install` script.
- **native** (PoC, opt-in): the `miao-native` addon with the landlock sandbox backend.
