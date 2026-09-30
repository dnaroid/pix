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
- Catalog entries use three rows: name, **SKILL** / **AGENT** type badge and
  optional tags after the badge; description; then status and **Local** / **Published** on the left with
  action buttons on the right. Missing descriptions still reserve the second
  row; long text truncates with full-value tooltips. Entries are separated by
  spacing, not colored divider lines. Project-sync rows are unchanged.
- Resource cards keep at most two direct commands: the routine Install / Update /
  Push / Pull action, plus Compare when a two-sided diff is available. Other
  commands are in a labeled **More actions** (`⋯`) menu: alternate conflict
  resolution, tags, Global/Project visibility, unpublication and deletion.
  Synced/context-only rows can therefore show only `⋯`. Menu commands retain
  existing busy/setup guards and confirmations; a missing project key disables
  **Make project** with a setup hint. The menu is not clipped by the catalog's
  scrolling container, flips/clamps within the viewport, and dismisses on outside
  interaction, catalog scroll, resize, refreshed items or changed availability.
  Keyboard traversal uses the shared menu contract; Escape and Tab return focus
  to the invoker (Tab then proceeds normally). Pending open/focus work is canceled
  by dismissal or teardown.
- Skills exposed by the ready active session's skill commands are marked
  **In context** and included in Installed even without a project copy (for
  example, globally loaded skills). Matching uses exact skill names and the
  command source, not descriptions or ordinary same-named commands. These
  skills offer no Install or missing-copy Update / Make local action. Updates
  to an existing project copy remain available. Context availability never
  implies project ownership: tags, uninstall and diff still require a local
  project copy. Switching sessions, reload or loss of readiness recomputes the
  marks; without a ready session the ordinary Registry catalog is unchanged.
- Registry is Desktop-only. ACP handles filesystem/Git operations directly,
  without loading tools-suite, starting a Pi runtime, or creating a session.
  There is no `/registry` command or TUI Registry UI.
- Newly discovered Local-only project skills and agents are saved automatically
  to the Project registry namespace through background `sync-project`. This
  requires a configured registry and project key. Full skill trees and agent
  companions are retained; globally/context-loaded skills without project copies
  are never published automatically. Existing published edits and unsafe states
  (untracked collisions, diverged, registry-changed or removed-remote) are not
  automatic publication targets. Later body/asset edits still require explicit push.
- **Save to project registry** explicitly publishes an unpublished project copy
  in the Project namespace. Pushes to existing publications retain their scope.
  Existing collision/conflict protection applies.
- Published resources have a **Make project** / **Make global** visibility
  toggle. Global definitions live in `skills/<name>` or `agents/<name>.md`;
  Project definitions live in `projects/<projectKey>/skills/<name>` or
  `projects/<projectKey>/agents/<name>.md`, including same-named agent companions.
  Project definitions appear only for the matching project key; Global remains
  visible everywhere. Initial publication is Project-scoped; Global requires
  the visibility toggle.
  The toggle requires a project key and confirmation, moves published bytes in
  one Git commit/push, and never changes or republishes local copies/edits.
  Provenance moves with the publication while retaining the local baseline and
  any pending remote update. Legacy provenance without a scope means Global.
- Global/Project name collisions are refused rather than shadowed or overwritten.
  Global promotion and a new Global publication also refuse a same-named
  definition in another project. Scoped install/update/push, diff, tags and
  unpublication target only the visible namespace. A scope/key change during
  asynchronous tag editing saves local tags but refuses automatic publication.
- Make local confirms unpublication. It installs a copy first if absent, then
  removes the shared definition and companions, retaining this project's copy
  and copies already installed in other projects. An existing modified local
  copy is not overwritten. Failed installation, an existing skill copy missing
  SKILL.md, or an invalid local agent definition never removes publication;
  existing local work must be repaired explicitly, not overwritten implicitly.
  Ordinary uninstall removes only the project copy; remove from registry is
  still available as a separate explicit deletion, not a conversion. Make local
  retains removal provenance so background sync does not undo explicit
  unpublication. An explicit push can republish the retained copy.
- Optional `tags` is a YAML string array in SKILL.md or agent frontmatter.
  Existing resources without tags remain valid. Tags travel with the resource
  through install/push/update. Tags are metadata, not runtime discovery/prompt
  or model-selection settings. Local metadata takes precedence over remote
  metadata even when the local tags are empty.
- Installed resources offer a prefilled tag editor. Comma-separated entries
  are trimmed and deduplicated; blank explicitly saves an empty array. Cancel
  changes nothing. Tag editing itself does not publish **Local** resources;
  never-published copies remain eligible for normal Project background saving.
  Explicitly unpublished copies stay local. For an
  already **Published** resource, tag saves automatically synchronize with the
  configured registry using the existing collision/provenance safeguards.
  A failed sync leaves the saved local edit intact and reports the error;
  automatic tag sync modifies remote tags only: unrelated local body, companion,
  or asset changes remain unpublished and still show as local changes.
  a changed remote revision or configuration during editing is never overwritten.
  Desktop displays tags and includes them in resource search.

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
  The ACP build must include the standalone Registry service for live verification.

## Implementation

- `acp/src/registry/service.ts`
- `acp/src/registry/resources.ts`
- `acp/src/registry/publication-location.ts`
- `acp/src/registry/publication-scope.ts`
- `acp/src/registry/project-resource-sync.ts`
- `acp/src/registry/metadata.ts`
- `acp/src/registry/agent-markdown.ts`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `acp/src/acp/desktop-commands.ts`
- `desktop/src/lib/registry.ts`
- `desktop/src/app/registry.svelte.ts`
- `desktop/src/components/RegistryPanel.svelte`
- `desktop/src/components/RegistryItemActions.svelte`
- `desktop/src/lib/registry-card-actions.ts`
- `skills/skill-creator/SKILL.md`
- `skills/skill-creator/scripts/quick_validate.py`
- `.pi/skills/project-agent-creator/SKILL.md`
- `.pi/skills/project-agent-creator/scripts/validate-agents.ts`

## Tests

- `acp/test/registry.test.ts`
- `acp/test/registry-metadata.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/desktop-commands.test.ts`
- `desktop/src/lib/registry.test.ts`
- `desktop/src/app/registry-store.test.ts`
- `desktop/src/components/RegistryPanel.test.ts`
- `desktop/src/lib/registry-card-actions.test.ts`

## Verification

Run targeted registry/metadata, ACP command-validation and Desktop unit tests,
tools-suite typecheck and Desktop/ACP typechecks. Real UI QA checks both tabs,
tag editing/search and both conversion directions with retained evidence.
