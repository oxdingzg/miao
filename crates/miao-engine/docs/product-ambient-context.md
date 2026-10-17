# Product ambient Context mapping

When the product creates a native engine owner, it maps the current Location's
resolved instruction, skill, and reference services into host-owned manifests.
It waits for Location plugin boot before reading plugin-contributed catalogs.
The standalone engine CLI continues to accept explicit manifests.

- Instructions use the same global/project/configured/remote discovery and
  refresh cache as `InstructionContext`. The bridge supplies the resolved list;
  `--workspace-instructions false` prevents standalone `AGENTS.md` discovery
  from duplicating or reintroducing a source disabled by product configuration.
- File-backed instructions retain their original paths. Native file policy is
  evaluated against the real source, and changes are read at provider turns.
  Configured remote instructions use exact-file temporary snapshots instead.
- Skills retain their registered directories and materialized download paths.
  Native directory and per-file policy apply before frontmatter is disclosed;
  their bodies and supporting files remain readable on demand. Embedded skills
  receive a dedicated snapshot directory.
- Non-hidden product references become exact read-only grants. External skill
  directories receive their own directory grants; instruction files receive
  exact-file grants without authorizing neighboring files.
- Explicit `contextConfigFile`, `skillsConfigFile`, and `referencesConfigFile`
  values take precedence over automatic mapping. With an explicit reference
  manifest, also supply explicit instruction and skill manifests.

Generated manifests and snapshots live outside the workspace in a private
temporary directory owned by the server's engine-owner scope. Remote instruction
bodies are refreshed atomically before external prompt admission, using the
product's existing cache and last-good fetch behavior. Local files are read by
the engine directly at provider-turn boundaries.

Reference authority and manifest identities are fixed when a child starts.
Changing the configured source list, adding a new reference, or changing an
embedded skill requires a new engine owner. Refreshing text does not extend an
existing child's filesystem grants. Normal native source counts, Context limits,
and permission policy still apply; excessive catalogs fail explicitly.

Cleanup follows the engine-owner scope rather than an individual HTTP request.
A remote Context refresh failure is returned before prompt admission, preserving
an explicit retry boundary. Reading status or cancelling an existing execution
does not refresh Context and remains available when a source is unavailable.
