# Reload context inventory

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

After `/reload` and other resource-reload flows, report the effective model, active tools, loadable skills, and available sub-agent roles without treating model-specific tool aliases as unavailable capabilities.

## Behavior

- The inventory preserves the active tool names exactly as exposed by the session.
- Skills come from the session resource loader and are shown when an active tool can load a skill file.
- File-access aliases are capability-equivalent for this check: `read`/`Read`, `bash`/`Bash`, `shell`, and `shell_command` all make loaded skills readable.
- If none of those tools is active, the inventory does not claim that loaded skills are usable in context and reports the file-access tools as inactive.
- Sub-agent roles are shown only while the `subagents` tool is active; a missing catalog remains distinct from an empty catalog.
- Duplicate skills, tools, and agent names are removed before display.

## Related files

- `src/app/commands/reload-context-inventory.ts`
- `src/app/commands/command-session-actions.ts`
- `tests/reload-context-inventory.test.ts`

## Verification

- Focused reload-context tests cover lowercase tools, PascalCase model-tool aliases, shell aliases, inactive file access, and missing sub-agent catalogs.
- Root TypeScript typecheck passes.
