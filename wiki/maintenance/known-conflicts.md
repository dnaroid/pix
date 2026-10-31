# Known documentation conflicts and lifecycle caveats

The migration relocated documentation without authorizing new product decisions.
Subsequent evidence-backed corrections are noted below. Preserve historical
rationale, distinguish it from current contracts, and do not hide implementation
gaps by weakening requirements.

## Search configuration: older guides versus the native contract

- [Configuration guide](../configuration/guide.md), [Desktop guide](../desktop/guide.md)
  and [troubleshooting](../getting-started/troubleshooting.md) now use the global
  suite configuration, not project `semantic.json` or independent consent flags.
- [Native repository search](../search/native-repository-search.md) and
  [global authorization decision](../decisions/0068-global-semantic-configuration.md)
  describe the current native/global `search.embedding` contract. Global embedding
  configuration does not override the enabled project source selection.
- Pure lexical lookup makes no embedding-provider calls; it can still update
  source-local indexes. Older “no writes” descriptions must not be generalized.

Use the native contract and current scripts when changing search. This migration
did not reconfigure a provider, enable extra sources or upload documents to
establish discoverability. Session queries use cached document vectors; eligible
background/manual indexing, not querying, creates session document embeddings.

## Desktop support and release asset matrices

- [Development](../development/guide.md), [installation](../getting-started/installation.md)
  and the opening scope of [LLM installation](../getting-started/llm-install.md)
  restrict Desktop support to macOS Apple Silicon.
- The LLM installation guide also contains Windows/Linux Desktop installation
  branches. They are not permission to expand the supported Desktop scope.
- [Release guide](../development/release/guide.md) and
  [distribution contract](../development/release/release-distribution.md) now
  match the current scripts: three TUI archives, a macOS ARM64 DMG and updater
  bundle (five public build assets), plus `latest.json` and `SHA256SUMS`.
  The one `.sig` is internal. Historical measurements and retained packaging
  branches are not fresh release inventory; check the
  [CI specification](../development/release/ci-release.md),
  [distribution contract](../development/release/release-distribution.md) and
  current release scripts.

The root README keeps the unambiguous macOS-only Desktop scope. This correction
does not expand platform support; older Windows/Linux installation branches
remain lifecycle caveats, not delivery authorization.

## Known implementation gap: terminal typography

[Package-script terminals](../desktop/integrations/desktop-package-scripts.md)
record the current xterm font size of 10 px. The
[Desktop design contract](../desktop/design.md#5-typography) requires at least
12 px, including dense technical chrome. The 10 px runtime is not a new design
exception. Documentation now distinguishes observed behavior from the unmet
requirement; changing the runtime and its tests remains implementation work.

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

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"d3c86919ef63424dda74d636cb890d7eb2ebb7737eb0567d5a8eea8a1eda8bf2","checkedAt":"2026-10-31T12:36:24.417Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":63,"reportLanguage":"ru"} -->
