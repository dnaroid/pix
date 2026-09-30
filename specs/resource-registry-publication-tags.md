---
kind: spec
status: active
---

# Registry publication scope and tags

## Behavior

- Skills and agents share the same publication model. **Local** means a project
  copy not published in the configured Git registry. **Published** means published
  in that shared registry, whether or not installed in this project. Publication is
  not a machine-wide automatically loaded resource: other projects explicitly
  install it. Project artifacts remain in the separate project-sync section.
- Desktop displays **Installed** (all project copies, published or not) and
  **Available** (remote copies absent locally) tabs. Cards independently show
  **Local** / **Published** badges and synchronization/conflict state.
- Only project artifacts sync automatically in the background; resource
  publication remains explicit.
- Make global uses registry push, retaining the project copy and complete skill
  trees or agent companions. Existing collision/conflict protection applies.
- Make local confirms unpublication. It installs a copy first if absent, then
  removes the shared definition and companions, retaining this project's copy
  and copies already installed in other projects. An existing modified local
  copy is not overwritten. Failed installation, an existing skill copy missing
  SKILL.md, or an invalid local agent definition never removes publication;
  existing local work must be repaired explicitly, not overwritten implicitly.
  Ordinary uninstall removes only the project copy; remove from registry is
  still available as a separate explicit deletion, not a conversion.
- Optional `tags` is a YAML string array in SKILL.md or agent frontmatter.
  Existing resources without tags remain valid. Tags travel with the resource
  through install/push/update. Tags are metadata, not runtime discovery/prompt
  or model-selection settings. Local metadata takes precedence over remote
  metadata even when the local tags are empty.
- Installed resources offer a prefilled tag editor. Comma-separated entries
  are trimmed and deduplicated; blank explicitly saves an empty array. Cancel
  changes nothing. Editing modifies only local metadata; explicit publish/sync
  shares the edit. Desktop displays tags and includes them in resource search.

## Constraints and failure cases

- Scope is relative to the currently configured registry, not every possible
  registry. Unpublication is shared; already installed copies remain unchanged.
- No silent overwrite of an unrelated same-named remote resource, including
  provenance that belongs to another registry/branch. Remote-only resources
  must be installed before editing tags. Local editing needs no Git connection.
- Tags allow at most 32 entries, 64 characters each, without commas, newlines
  or NUL. Agent frontmatter rejects non-string-array tags. Malformed optional
  skill tag metadata does not hide an otherwise usable catalog entry.
- Editing preserves unrelated YAML/body, rejects malformed/duplicate tag
  frontmatter and symlinked paths, and refuses stale file contents after an
  asynchronous dialog. Cancellation and failures must not overwrite newer work.
- Actions remain workspace-scoped and validate resource type and safe name.
  Source/live tools-suite synchronization is required before live verification.

## Implementation

- `external/pi-tools-suite/src/resource-registry/index.ts`
- `external/pi-tools-suite/src/resource-registry/metadata.ts`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `acp/src/acp/desktop-commands.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `skills/skill-creator/SKILL.md`
- `skills/skill-creator/scripts/quick_validate.py`
- `.pi/skills/project-agent-creator/SKILL.md`
- `.pi/skills/project-agent-creator/scripts/validate-agents.ts`

## Tests

- `external/pi-tools-suite/test/resource-registry.test.ts`
- `external/pi-tools-suite/test/resource-registry-metadata.test.ts`
- `acp/test/desktop-commands.test.ts`
- `desktop/src/lib/registry.test.ts`
- `desktop/src/components/RegistryPanel.test.ts`

## Verification

Run targeted registry/metadata, ACP command-validation and Desktop unit tests,
tools-suite typecheck and Desktop/ACP typechecks. Real UI QA checks both tabs,
tag editing/search and both conversion directions with retained evidence.
