---
kind: spec
status: active
---

# Reload context inventory

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

After `/reload` and other resource-reload flows, report loaded context file paths, the effective model, active tools, loadable skills, and available sub-agent roles without treating model-specific tool aliases as unavailable capabilities.

## Behavior

- The inventory preserves the active tool names exactly as exposed by the session.
- `Context files (in context)` lists the paths of the context instruction files actually loaded by the current session resource loader (including effective `AGENTS.md` / `AGENTS.override.md` files). It does not scan the filesystem, include file contents, or confuse discoverable skills with injected instruction files. Paths are deduplicated in loader order and reported even when file-access tools are inactive.
- An empty context file list is shown as `(none)`; an older ACP inventory with no context file field is shown as `(inventory unavailable)`, never as proof that no files loaded. Desktop renders Markdown-significant characters in paths literally.
- Skills come from the session resource loader and are shown when an active tool can load a skill file.
- File-access aliases are capability-equivalent for this check: `read`/`Read`, `bash`/`Bash`, `shell`, and `shell_command` all make loaded skills readable.
- If none of those tools is active, the inventory does not claim that loaded skills are usable in context and reports the file-access tools as inactive.
- Sub-agent roles are shown only while the `subagents` tool is active; a missing catalog remains distinct from an empty catalog.
- Duplicate skills, tools, and agent names are removed before display.
- Desktop inventory text escapes Markdown-significant underscores in skill, tool, and agent identifiers before it reaches `MarkdownText`, so names such as `repo_inspect` remain visually literal instead of being parsed as emphasis across neighbouring names.

## Related files

- `src/app/commands/reload-context-inventory.ts`
- `src/app/commands/command-session-actions.ts`
- `acp/src/acp/context-inventory.ts`
- `acp/src/pi/context-inventory-host.js`
- `acp/src/pi/pix-rpc-entry.js`
- `tests/reload-context-inventory.test.ts`
- `acp/test/context-inventory.test.ts`
- `acp/test/context-inventory-host.test.ts`

## Verification

- Focused reload-context tests cover lowercase tools, PascalCase model-tool aliases, shell aliases, inactive file access, and missing sub-agent catalogs.
- ACP formatting tests cover Markdown-safe display of underscored identifiers in Desktop model/reload inventory messages.
- Context file tests cover loader order/deduplication, inactive file-access tools, legacy/malformed inventories, and Markdown-safe paths. RPC host tests cover refreshed loader paths after reload, replacement-session ownership, empty lists, unrelated widgets, and graceful loader failure without exposing file contents.
- Root TypeScript typecheck passes.

## Implementation

- `src/app/commands/reload-context-inventory.ts`
- `acp/src/acp/context-inventory.ts`

## Tests

- `tests/reload-context-inventory.test.ts`
