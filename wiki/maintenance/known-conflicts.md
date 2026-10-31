# Known documentation conflicts and lifecycle caveats

The migration relocates documentation; it does not authorize a new interpretation
of conflicting requirements. Original passages and their metadata are preserved.
The following discrepancies need an evidence-backed follow-up, not silent merging.

## Search configuration: older guides versus the native contract

- [Configuration guide](../configuration/guide.md), [Desktop guide](../desktop/guide.md)
  and [troubleshooting](../getting-started/troubleshooting.md) retain descriptions
  of project `.pi/search/semantic.json`, per-source semantic consent and/or a
  pinned search provider.
- [Native repository search](../search/native-repository-search.md) and
  [global authorization decision](../decisions/0068-global-semantic-configuration.md)
  describe the current native/global `search.embedding` contract. Global embedding
  configuration does not override the enabled project source selection.
- Pure lexical lookup makes no embedding-provider calls; it can still update
  source-local indexes. Older “no writes” descriptions must not be generalized.

Use the native contract and current scripts when changing search. This migration
did not reconfigure a provider, enable extra sources or upload documents to
establish discoverability. The older guide passages remain visible as drift.

## Desktop support and release asset matrices

- [Development](../development/guide.md), [installation](../getting-started/installation.md)
  and the opening scope of [LLM installation](../getting-started/llm-install.md)
  restrict Desktop support to macOS Apple Silicon.
- The LLM installation guide also contains Windows/Linux Desktop installation
  branches. They are not permission to expand the supported Desktop scope.
- [Release guide](../development/release/guide.md) retains older counts/matrices
  for seven assets/four updater targets and a version-specific historical claim.
  These must not be treated as a fresh release inventory without checking the
  [CI specification](../development/release/ci-release.md),
  [distribution contract](../development/release/release-distribution.md) and
  current release scripts.

The root README keeps the unambiguous macOS-only Desktop scope. Original detailed
texts remain intact rather than silently rewriting platform requirements.

## Accepted ADRs can be partly superseded

- [Window tiling ADR 0029](../decisions/0029-window-tiling.md) retains display/state
  policies; its uniform-grid choice is replaced by
  [0040](../decisions/0040-gap-free-window-tiling.md) and the
  [current tiling specification](../desktop/workbench/desktop-window-tiling.md).
- [Status hover ADR 0037](../decisions/0037-status-bar-hover-details.md) is superseded
  for opening/retention/dismissal, not for all content and chrome choices; see
  [0048](../decisions/0048-status-bar-click-popups.md).
- Other replacements are recorded in each ADR. Numeric collisions already exist
  (for example two distinct 0016, 0026 and 0028 records). They are preserved:
  filenames, not just numeric prefixes, identify a record.

These are documented scope distinctions, not new conflicts to resolve by deleting
the older rationale. The [archive index](../archive/index.md) points to superseded
records without renumbering them.

## Proposals, experiments, incidents and old evidence

- [Code-health material](../proposals/pix-code-health/index.md) is a proposal for
  agreement. Five discussion rounds do not imply approved architecture, runtime
  pilots or implementation.
- [Observer](../assistants/observer/index.md) and
  [historical thinking pruning](../context/historical-thinking-prune.md) retain
  their experimental scope. A frontmatter `active` label alone is not rollout.
- [Prompt RPC timeout](../operations/incidents/prompt-rpc-timeout.md) is an unresolved
  reported observation with unknown cause, not a verified fix.
- [Operation-lock audit](../architecture/desktop-operation-lock-audit.md) records
  open work; it was not archived as completed.
- [ACP documentation](../architecture/acp.md) and the package changelog include
  evidence against Pi 0.84.4. Those historical observations are preserved, not
  presented as current-SDK test results.

The complete original [contract overview](../reference/contracts.md) contains
additional known unknowns and historical consolidation notes. Preserve those
caveats when editing the corresponding feature contracts.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"48c60883b11ff19fec4d79deaa323e7bb3e2eb8cd9684c8900890f9c96046604","checkedAt":"2026-10-31T00:11:26.958Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":57,"reportLanguage":"ru"} -->
