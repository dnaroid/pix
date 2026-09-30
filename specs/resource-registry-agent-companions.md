---
kind: spec
status: active
---

# Registry agent companion directories

## Behavior

An agent is identified by `agents/<name>.md` in the private Git registry or
`.pi/agents/<name>.md` in a project. If a sibling directory `agents/<name>/`
exists, it belongs to that agent and is synchronized recursively along with
the Markdown definition. A directory without a valid matching definition is
not a separate Registry resource.

Install and update replace both components, including removal of an obsolete
local companion when the remote no longer has one. Push replaces both remote
components, including deleting an obsolete remote companion. Remove deletes
both remote components but retains the project copy; uninstall deletes both
local components but retains the registry copy. Registry is available only in
Pix Desktop; operations run directly in ACP without a Pi session.

Status and provenance hash both components when the companion exists, detecting
edits, additions, and deletion of local assets. Remote revisions follow both
paths, so companion-only commits show as updates or divergence. File-only
agents retain their original file hash for existing provenance compatibility.

## Constraints and failure cases

The companion must be a regular directory, not a symlink or file. Its nested
contents follow the same copy/hash rule as skill trees: symbolic links and
unsupported filesystem entries are rejected rather than followed. Registry
operations continue to validate the Markdown definition before syncing.
Only the named agent's two paths are staged/committed; other agents are not
included in an agent push or remove. As with other Git-backed Registry trees,
an empty companion directory alone cannot be transported by Git.

## Implementation

- `acp/src/registry/resource-files.ts`
- `acp/src/registry/resources.ts`
- `acp/src/registry/status.ts`

## Tests

- `acp/test/registry.test.ts`

## Verification

Run the ACP resource registry tests and typecheck. Confirm companion-only
edits and removals change status, transfer on push/update, and are removed by
uninstall/remove without changing other agents.
