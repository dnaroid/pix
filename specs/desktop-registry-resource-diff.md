---
kind: spec
status: active
---

# Desktop Registry resource diff

## Behavior

In the Desktop Registry catalog, a reusable skill or agent whose local project
copy and global Git registry copy both exist and whose status indicates a
possible difference has a **Diff** action.
It is available for local edits, remote updates, divergence and untracked
local copies, including a resource whose recorded provenance points to another
registry. A resource with only one copy, or one that is up to date, does
not offer a two-sided comparison. Project-sync artifacts are outside this
view.

Opening Diff reads the current copies on demand without syncing either side.
The comparison labels the registry copy as the old side and the project-local
copy as the new side, regardless of which side changed since the last sync.
It lists changed files with a readable, per-file text diff, including added
and removed files. For an agent this includes `agents/<name>.md` and every
file beneath the optional `agents/<name>/` companion directory; for a skill
it includes the skill tree. Binary or oversized changed files remain visible
with a notice rather than disappearing or dumping their contents. A successful
comparison never pushes, pulls, installs or overwrites resources.

## Constraints and failure cases

Diff requests identify one validated resource type and name within a workspace;
the backend resolves only that resource's known local and registry paths.
Traversal rejects links and unsupported filesystem entries rather than
following them. Content and response sizes are bounded. Missing copies,
unavailable registry data and read errors surface as visible errors instead
of a misleading empty diff. Loading/failed/empty states are distinct, and
late responses from a closed view, previous selection or previous workspace
must not replace the current view.

## Implementation

- `external/pi-tools-suite/src/resource-registry/index.ts`
- `external/pi-tools-suite/src/resource-registry/diff.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/app/registry.svelte.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `desktop/src/components/RegistryDiffPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`

## Tests

- `external/pi-tools-suite/test/resource-registry.test.ts`
- `acp/test/desktop-commands.test.ts`
- `acp/test/agent.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/registry.test.ts`
- `desktop/src/app/registry.test.ts`
- `desktop/src/components/RegistryPanel.test.ts`

## Verification

Exercise agent sidecar-only edits/additions/removals and skill-tree changes,
including the direction of additions/removals; verify request validation,
read-only operation, binary/size handling, error states and stale-workspace
guards. Run focused backend, ACP and Desktop tests plus their type checks.
